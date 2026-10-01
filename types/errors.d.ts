// The fields this code puts on errors it throws, so that `error.code = "x"` is
// checked like everything else. An error here is an ordinary Error with a few
// optional facts attached; none is ever required.
interface Error {
  code?: string;
  statusCode?: number;
  exitCode?: number | null;
  result?: any;
  details?: any;
  path?: string;
  reason?: string;
  provider?: string;
  providerAttempts?: any;
  budget?: any;
  accounting?: any;
  usage?: any;
  model?: string;
  toolCalls?: any;
  quorum?: any;
  steps?: any;
  run?: any;
  workflow?: any;
  workspaceCleanup?: any;
  sealFailure?: string;
  lease?: any;
  retryable?: boolean;
  safeToRetry?: boolean;
  retryAfterMs?: number;
}
