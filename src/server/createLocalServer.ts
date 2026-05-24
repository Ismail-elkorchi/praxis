import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse as HttpResponse } from "node:http";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { PraxisRuntime } from "../app/PraxisApp";
import { PraxisApi, type ClientRequest } from "../app/PraxisApi";
import type { DomainEvent } from "../core";

export type LocalServerOptions = {
  app: PraxisRuntime;
  staticRoot?: string;
};

const pushChannelsByMethod: Record<string, string[]> = {
  "projects.register": ["dashboard.snapshotChanged", "project.stateChanged"],
  "projects.update": ["dashboard.snapshotChanged", "project.stateChanged"],
  "projects.archive": ["dashboard.snapshotChanged", "project.stateChanged"],
  "projects.refresh": ["dashboard.snapshotChanged", "project.stateChanged"],
  "agents.startSession": ["dashboard.snapshotChanged", "agent.sessionUpdated"],
  "agents.resumeSession": ["dashboard.snapshotChanged", "agent.sessionUpdated"],
  "agents.stopSession": ["dashboard.snapshotChanged", "agent.sessionUpdated"],
  "agents.sendTurn": ["dashboard.snapshotChanged", "agent.turnUpdated"],
  "agents.steerTurn": ["dashboard.snapshotChanged", "agent.turnUpdated"],
  "agents.interruptTurn": ["dashboard.snapshotChanged", "agent.turnUpdated"],
  "agents.respondToApproval": ["dashboard.snapshotChanged", "approval.resolved"],
  "agents.respondToUserInput": ["dashboard.snapshotChanged", "agent.turnUpdated"],
  "providers.checkAvailability": ["dashboard.snapshotChanged", "provider.statusChanged"],
  "settings.update": ["dashboard.snapshotChanged"],
  "checks.run": ["dashboard.snapshotChanged", "check.updated"],
  "checks.cancel": ["dashboard.snapshotChanged", "check.updated"],
  "git.createWorktree": ["dashboard.snapshotChanged", "git.statusChanged"]
};

export function createLocalServer(options: LocalServerOptions) {
  const api = new PraxisApi(options.app);
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && request.url === "/api") {
        const body = await readBody(request);
        const clientRequest = JSON.parse(body) as ClientRequest;
        const beforeSequence = await latestEventSequence();
        const started = performance.now();
        const result = await api.handle(clientRequest);
        options.app.observability.recordApiRequest({
          method: clientRequest.method,
          durationMs: performance.now() - started,
          ok: !("error" in result)
        });
        writeJson(response, "error" in result ? 400 : 200, result);
        if (!("error" in result)) {
          await broadcastPushes(clientRequest.method, beforeSequence);
        }
        return;
      }

      if (request.method === "GET" && options.staticRoot) {
        if (await serveStatic(options.staticRoot, request, response)) {
          return;
        }
      }

      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : "Unexpected error." });
    }
  });

  const sockets = new WebSocketServer({ server, path: "/ws" });

  sockets.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "push", channel: "dashboard.snapshotChanged", data: options.app.snapshot().dashboard }));
    socket.on("message", async (message) => {
      const clientRequest = JSON.parse(String(message)) as ClientRequest;
      const beforeSequence = await latestEventSequence();
      const started = performance.now();
      const result = await api.handle(clientRequest);
      options.app.observability.recordApiRequest({
        method: clientRequest.method,
        durationMs: performance.now() - started,
        ok: !("error" in result)
      });
      socket.send(JSON.stringify(result));
      if (!("error" in result)) {
        await broadcastPushes(clientRequest.method, beforeSequence);
      }
    });
  });

  async function latestEventSequence(): Promise<number> {
    const events = await options.app.events.queryEvents();
    return Math.max(0, ...events.map((event) => event.sequence ?? 0));
  }

  async function broadcastPushes(method: string, beforeSequence: number): Promise<void> {
    const newEvents = await options.app.events.queryEvents({ afterSequence: beforeSequence });
    const channels = channelsForMutation(method, newEvents);
    for (const channel of channels) {
      broadcast(channel, options.app.snapshot().dashboard);
    }
  }

  function broadcast(channel: string, data: unknown): void {
    const payload = JSON.stringify({ type: "push", channel, data });
    for (const client of sockets.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  return { server, sockets, api, broadcast };
}

function channelsForMutation(method: string, events: DomainEvent[]): string[] {
  const channels = new Set(pushChannelsByMethod[method] ?? []);
  for (const event of events) {
    for (const channel of channelsForEvent(event)) {
      channels.add(channel);
    }
  }
  if (channels.size > 0 && events.length > 0) {
    channels.add("dashboard.snapshotChanged");
  }
  return [...channels];
}

function channelsForEvent(event: DomainEvent): string[] {
  if (event.type === "approval.requested") return ["approval.requested"];
  if (["approval.accepted", "approval.declined", "approval.cancelled", "approval.expired"].includes(event.type)) {
    return ["approval.resolved"];
  }
  if (event.type.startsWith("agent.session")) return ["agent.sessionUpdated"];
  if (
    event.type.startsWith("agent.turn") ||
    event.type.startsWith("agent.command") ||
    event.type.startsWith("agent.fileChange") ||
    event.type.startsWith("agent.userInput")
  ) {
    return ["agent.turnUpdated"];
  }
  if (event.type.startsWith("check.")) return ["check.updated"];
  if (event.type === "git.statusChanged" || event.type === "git.worktree.created") return ["git.statusChanged"];
  if (event.type.startsWith("provider.")) return ["provider.statusChanged"];
  if (event.type.startsWith("project.")) return ["project.stateChanged"];
  return [];
}

async function serveStatic(staticRoot: string, request: IncomingMessage, response: HttpResponse): Promise<boolean> {
  const parsed = new URL(request.url ?? "/", "http://127.0.0.1");
  const requestedPath = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const resolved = path.resolve(staticRoot, `.${requestedPath}`);
  const root = path.resolve(staticRoot);
  if (!resolved.startsWith(root)) {
    return false;
  }

  const filePath = existsSync(resolved) ? resolved : path.join(root, "index.html");
  const fileStat = await stat(filePath).catch(() => undefined);
  if (!fileStat?.isFile()) {
    return false;
  }

  response.writeHead(200, { "content-type": contentType(filePath) });
  createReadStream(filePath).pipe(response);
  return true;
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function writeJson(response: HttpResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    request.on("data", (chunk: Buffer) => {
      data += String(chunk);
    });
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}
