export type JsonRpcId = number | string;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorPayload;
};

export type JsonRpcErrorPayload = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type CodexAppServerErrorName =
  | "ContextWindowExceeded"
  | "UsageLimitExceeded"
  | "HttpConnectionFailed"
  | "ResponseStreamConnectionFailed"
  | "ResponseStreamDisconnected"
  | "ResponseTooManyFailedAttempts"
  | "BadRequest"
  | "Unauthorized"
  | "SandboxError"
  | "InternalServerError"
  | "Other";

