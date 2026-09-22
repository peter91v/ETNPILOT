import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { ApprovalInbox, createInboxApprovalHandler } from "../core/approval-inbox.js";
import { GitLabClient } from "./client.js";
import { WebhookDeliveryStore } from "./delivery-store.js";
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
  const deliveryStore = new WebhookDeliveryStore(
    resolve(projectRoot, webhook.deliveryStore ?? ".etnpilot/state/webhooks"),
  );
  const shutdown = new AbortController();
  const inboxConfig = config.approval?.inbox ?? {};
  const approvalInbox = inboxConfig.enabled === false ? undefined : new ApprovalInbox(
    resolve(projectRoot, inboxConfig.database ?? ".etnpilot/state/approvals.sqlite"),
  );
  const approvalHandler = approvalInbox ? createInboxApprovalHandler({
    inbox: approvalInbox,
    timeoutMs: inboxConfig.timeoutMs ?? 24 * 60 * 60_000,
    pollIntervalMs: inboxConfig.pollIntervalMs ?? 500,
    signal: shutdown.signal,
  }) : undefined;
  const issueTrigger = new GitLabIssueTrigger({
    root: projectRoot,
    config,
    env,
    client,
    run,
    approvalHandler,
    onSyncError: onError,
  });
  let queue = Promise.resolve();
  const enqueue = (operation) => {
    const current = queue.then(operation);
    queue = current.catch(onError);
    return current;
  };

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
      const claim = await deliveryStore.claim(deliveryId, {
        event,
        project: payload.project.path_with_namespace,
        issueIid: match.issue.iid,
        action: match.issue.action,
      });
      if (!claim.claimed) return json(response, 200, { accepted: false, duplicate: true, status: claim.record?.status });

      enqueue(async () => {
        await deliveryStore.mark(deliveryId, "running");
        try {
          const result = await issueTrigger.execute(payload, deliveryId);
          await deliveryStore.mark(deliveryId, "succeeded", { result });
        } catch (error) {
          await deliveryStore.mark(deliveryId, "failed", {
            error: {
              name: error instanceof Error ? error.name : "Error",
              runId: error.run?.runId,
              message: "Workflow execution failed. Inspect server logs and the run receipt.",
            },
          });
          throw error;
        }
      });
      return json(response, 202, { accepted: true, deliveryId });
    } catch (error) {
      const status = error.statusCode ?? 500;
      if (status >= 500) onError(error);
      return json(response, status, { error: status === 413 ? "payload-too-large" : "request-failed" });
    }
  });

  return {
    server,
    config,
    deliveryStore,
    approvalInbox,
    drain: () => queue,
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
      shutdown.abort();
      await new Promise((resolveClose, reject) => {
        server.close((error) => {
          if (error) return reject(error);
          resolveClose();
        });
      });
      try {
        await queue;
      } finally {
        approvalInbox?.close();
      }
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
