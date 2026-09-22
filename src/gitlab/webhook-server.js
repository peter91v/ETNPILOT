import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { ApprovalInbox, createInboxApprovalHandler } from "../core/approval-inbox.js";
import { WorkflowQueue } from "../workflow/queue.js";
import { WorkflowQueueWorker } from "../workflow/queue-worker.js";
import { GitLabClient } from "./client.js";
import { GitLabIssueTrigger } from "./issue-trigger.js";
import { authenticateGitLabWebhook, deliveryIdFromHeaders } from "./webhook-auth.js";

export async function createGitLabWebhookServer({
  root = process.cwd(),
  env = process.env,
  fetchImpl,
  run,
  now,
  onError = (error) => console.error(error),
} = {}) {
  const projectRoot = resolve(root);
  const config = await loadConfig(join(projectRoot, ".etnpilot", "etnpilot.yaml"), env);
  const webhook = config.git?.webhook ?? {};
  const signingSecret = env.ETNPILOT_GITLAB_WEBHOOK_SIGNING_SECRET;
  const token = env.ETNPILOT_GITLAB_WEBHOOK_TOKEN;
  if (!signingSecret && !token) {
    throw new Error("A GitLab webhook signing secret or webhook token is required.");
  }
  const issueTriggerConfig = config.git?.issueTrigger ?? {};
  const requiresApiToken = issueTriggerConfig.enabled === true && (
    issueTriggerConfig.syncStatus !== false
    || issueTriggerConfig.comment === true
    || issueTriggerConfig.publish === true
  );
  if (requiresApiToken && !env.ETNPILOT_GITLAB_TOKEN) {
    throw new Error("ETNPILOT_GITLAB_TOKEN is required when the GitLab issue trigger is enabled.");
  }
  const client = new GitLabClient({
    baseUrl: config.git?.baseUrl,
    token: env.ETNPILOT_GITLAB_TOKEN,
    fetchImpl,
  });
  const queueConfig = config.queue ?? {};
  const workflowQueue = new WorkflowQueue(
    resolve(projectRoot, queueConfig.database ?? ".etnpilot/state/workflows.sqlite"),
  );
  const inboxConfig = config.approval?.inbox ?? {};
  const approvalInbox = inboxConfig.enabled === false ? undefined : new ApprovalInbox(
    resolve(projectRoot, inboxConfig.database ?? ".etnpilot/state/approvals.sqlite"),
  );
  const issueTrigger = new GitLabIssueTrigger({
    root: projectRoot,
    config,
    env,
    client,
    run,
    onSyncError: onError,
  });
  const queueWorker = new WorkflowQueueWorker({
    queue: workflowQueue,
    pollIntervalMs: queueConfig.pollIntervalMs ?? 500,
    leaseMs: queueConfig.leaseMs ?? 30_000,
    retryDelayMs: queueConfig.retryDelayMs ?? 5_000,
    onError,
    execute: async (job, execution) => {
      if (job.kind !== "gitlab-issue") throw new Error(`Unsupported workflow job kind: '${job.kind}'.`);
      const inboxHandler = approvalInbox ? createInboxApprovalHandler({
        inbox: approvalInbox,
        timeoutMs: inboxConfig.timeoutMs ?? 24 * 60 * 60_000,
        pollIntervalMs: inboxConfig.pollIntervalMs ?? 500,
        signal: execution.signal,
        onPending: (approval) => execution.checkpoint({
          phase: "waiting-approval",
          approvalId: approval.id,
        }),
        onResolved: (approval) => execution.checkpoint({
          phase: "approval-resolved",
          approvalId: approval.id,
          approvalStatus: approval.status,
        }),
      }) : undefined;
      const approvalHandler = inboxHandler
        ? (request, context = {}) => inboxHandler(request, { ...context, queueJobId: job.id })
        : undefined;
      return issueTrigger.execute(job.payload, job.deliveryId, { ...execution, approvalHandler });
    },
  }).start();

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== (webhook.path ?? "/webhooks/gitlab")) {
        return json(response, 404, { error: "not-found" });
      }
      const rawBody = await readBody(request, webhook.maxBodyBytes ?? 1_048_576);
      const auth = authenticateGitLabWebhook({
        headers: request.headers,
        rawBody,
        signingSecret,
        token,
        now: now?.(),
        timestampToleranceSeconds: webhook.timestampToleranceSeconds ?? 300,
      });
      if (!auth.authenticated) return json(response, 401, { error: "unauthorized" });
      const deliveryId = deliveryIdFromHeaders(request.headers);
      if (!deliveryId) return json(response, 400, { error: "delivery-id-required" });
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return json(response, 400, { error: "invalid-json" });
      }
      const event = request.headers["x-gitlab-event"];
      const match = issueTrigger.matches(event, payload);
      if (!match.matched) return json(response, 202, { accepted: false, reason: match.reason });
      const queued = workflowQueue.enqueue({
        kind: "gitlab-issue",
        deliveryId,
        payload: queueIssuePayload(payload),
        metadata: {
          event,
          project: payload.project.path_with_namespace,
          issueIid: match.issue.iid,
          action: match.issue.action,
        },
        maxAttempts: queueConfig.maxAttempts ?? 1,
      });
      if (!queued.enqueued) {
        return json(response, 200, {
          accepted: false,
          duplicate: true,
          jobId: queued.job?.id,
          status: queued.job?.status,
        });
      }
      queueWorker.wake();
      return json(response, 202, { accepted: true, deliveryId, jobId: queued.job.id });
    } catch (error) {
      const status = error.statusCode ?? 500;
      if (status >= 500) onError(error);
      return json(response, status, { error: status === 413 ? "payload-too-large" : "request-failed" });
    }
  });

  return {
    server,
    config,
    workflowQueue,
    queueWorker,
    approvalInbox,
    drain: (options) => queueWorker.waitForIdle(options),
    listen({ host = webhook.host ?? "127.0.0.1", port = webhook.port ?? 8787 } = {}) {
      return new Promise((resolveListen, reject) => {
        const onListenError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onListenError);
          resolveListen(server.address());
        };
        server.once("error", onListenError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    async close() {
      if (server.listening) {
        await new Promise((resolveClose, reject) => {
          server.close((error) => {
            if (error) return reject(error);
            resolveClose();
          });
        });
      }
      try {
        await queueWorker.stop();
      } finally {
        approvalInbox?.close();
        workflowQueue.close();
      }
    },
  };
}

function queueIssuePayload(payload) {
  const issue = payload.object_attributes ?? {};
  return {
    object_kind: "issue",
    user: { username: payload.user?.username },
    project: {
      path_with_namespace: payload.project?.path_with_namespace,
      default_branch: payload.project?.default_branch,
    },
    labels: (payload.labels ?? []).map((label) => ({
      title: typeof label === "string" ? label : label.title,
    })),
    object_attributes: {
      iid: issue.iid,
      action: issue.action,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      confidential: issue.confidential === true,
    },
  };
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Webhook payload exceeds the configured limit.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}
