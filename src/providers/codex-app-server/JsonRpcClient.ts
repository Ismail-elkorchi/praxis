import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { CodexJsonRpcError, CodexTransportError, isOverloadError } from "./errors";
import type { JsonRpcId, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./ProtocolTypes";
import { redactCodexText, redactCodexValue } from "./redaction";

export type CodexJsonRpcClientOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxOverloadRetries?: number;
  retryDelayMs?: number;
  onNotification?(message: JsonRpcNotification): void;
  onServerRequest?(message: JsonRpcRequest): void;
  onStderr?(line: string): void;
  onCrash?(error: Error): void;
};

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export class CodexJsonRpcClient {
  private process?: ChildProcessWithoutNullStreams;
  private lineReader?: readline.Interface;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private crashed = false;

  constructor(private readonly options: CodexJsonRpcClientOptions) {}

  get running(): boolean {
    return Boolean(this.process && !this.process.killed && !this.crashed);
  }

  start(): void {
    if (this.running) return;
    this.crashed = false;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: "pipe"
    });
    this.process = child;

    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.handleLine(line));

    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line) => this.options.onStderr?.(redactCodexText(line)));
    child.once("error", (error) => this.handleCrash(error));
    child.once("exit", (code, signal) => {
      stderrReader.close();
      if (code !== 0 && code !== null) {
        this.handleCrash(new CodexTransportError("Codex app-server process exited.", { code, signal: signal ?? undefined }));
      }
    });
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    let attempts = 0;
    const maxAttempts = (this.options.maxOverloadRetries ?? 1) + 1;
    while (true) {
      try {
        return (await this.sendRequest(method, params)) as T;
      } catch (error) {
        attempts += 1;
        if (attempts >= maxAttempts || !isOverloadError(error)) {
          throw error;
        }
        await delay(this.options.retryDelayMs ?? 25);
      }
    }
  }

  notify(method: string, params?: unknown): void {
    this.ensureRunning();
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.ensureRunning();
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId, error: { code: number; message: string; data?: unknown }): void {
    this.ensureRunning();
    this.write({ jsonrpc: "2.0", id, error: redactCodexValue(error) });
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexTransportError("Codex app-server client stopped."));
    }
    this.pending.clear();
    this.lineReader?.close();
    this.process?.kill();
    this.process = undefined;
    this.crashed = false;
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    this.ensureRunning();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexTransportError("Codex app-server request timed out.", { method }));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new CodexTransportError("Codex app-server request failed."));
      }
    });
  }

  private write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    this.ensureRunning();
    this.process!.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private ensureRunning(): void {
    if (!this.running) {
      this.start();
    }
    if (!this.process?.stdin.writable) {
      throw new CodexTransportError("Codex app-server transport is not writable.");
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.options.onNotification?.({
        jsonrpc: "2.0",
        method: "provider.rawEvent",
        params: { normalizationFailure: "invalid_json", line: redactCodexText(line) }
      });
      return;
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      this.handleResponse(message);
      return;
    }
    if ("id" in message && "method" in message) {
      this.options.onServerRequest?.(redactCodexValue(message));
      return;
    }
    if ("method" in message) {
      this.options.onNotification?.(redactCodexValue(message));
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new CodexJsonRpcError(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private handleCrash(error: Error): void {
    if (this.crashed) return;
    this.crashed = true;
    const crashError =
      error instanceof CodexTransportError
        ? error
        : new CodexTransportError(error.message, { name: error.name });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(crashError);
    }
    this.pending.clear();
    this.options.onCrash?.(crashError);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
