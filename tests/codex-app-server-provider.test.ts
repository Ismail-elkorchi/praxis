import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { CodexAppServerProviderAdapter, codexFeatureMatrix } from "../src/providers/codex-app-server";
import { checkCodexAppServerAvailability, schemaStrategy } from "../src/providers/codex-app-server/Compatibility";
import { CodexJsonRpcClient } from "../src/providers/codex-app-server/JsonRpcClient";
import { validateProviderAdapterContract } from "../src/providers/interface";
import { createTempProject } from "./helpers/tempProject";

const trackedAdapters = new Set<CodexAppServerProviderAdapter>();

afterEach(() => {
  for (const adapter of trackedAdapters) {
    adapter.shutdown();
  }
  trackedAdapters.clear();
});

describe("CodexAppServerProviderAdapter", () => {
  it("is disabled unless configured and reports unavailable without Codex installed", async () => {
    const app = await createPraxisApp();
    expect(app.providerRegistry.listRealProviders()).toEqual([]);
    expect(app.snapshot().dashboard.providerStatus.map((provider) => provider.name)).toEqual(["Fake provider"]);

    const adapter = createCodexAdapter({ command: "/not-installed/codex" });
    await expect(adapter.checkAvailability()).resolves.toMatchObject({
      status: "unavailable",
      reason: "Codex app-server command is not available."
    });
  });

  it("passes the provider contract with a fake app-server fixture", async () => {
    const command = await createFakeCodexAppServer();
    const adapter = createCodexAdapter({
      id: providerId("codex-app-server-test"),
      command,
      args: ["app-server", "--stdio"]
    });

    await expect(validateProviderAdapterContract(adapter, { expectedId: adapter.id })).resolves.toEqual({
      providerId: adapter.id,
      failures: []
    });
    await expect(adapter.checkAvailability()).resolves.toMatchObject({
      status: "available",
      version: "0.2.0"
    });
  });

  it("checks compatibility and exposes schema generation commands", async () => {
    const oldCommand = await createFakeCodexAppServer({ version: "0.0.1" });

    await expect(checkCodexAppServerAvailability({ command: oldCommand, minimumVersion: "0.1.0" })).resolves.toMatchObject({
      status: "incompatible",
      version: "0.0.1"
    });
    expect(schemaStrategy("codex")).toEqual({
      typescriptCommand: ["codex", "app-server", "generate-ts"],
      jsonSchemaCommand: ["codex", "app-server", "generate-json-schema"]
    });
  });

  it("starts, resumes, reads, lists, imports, steers, and interrupts sessions", async () => {
    const command = await createFakeCodexAppServer();
    const adapter = createCodexAdapter({ id: providerId("codex-app-server-flow"), command, args: ["app-server"] });
    const app = await createPraxisApp({ providerAdapters: [adapter] });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: adapter.id, projectId: project.id, cwd: rootPath, goal: "Implement" });

    const turnId = await app.providers.sendTurn({
      providerId: adapter.id,
      projectId: project.id,
      sessionId,
      instruction: "Make a change"
    });
    await app.providers.resumeSession({ providerId: adapter.id, sessionId });
    await app.providers.steerTurn({ providerId: adapter.id, sessionId, turnId, input: "Use the smaller change." });
    await app.providers.interruptTurn({ providerId: adapter.id, sessionId, turnId, reason: "User stopped it." });

    await expect(app.providers.readSession({ providerId: adapter.id, sessionId })).resolves.toMatchObject({
      session: expect.objectContaining({ id: sessionId, providerId: adapter.id })
    });
    await expect(app.providers.listSessions({ providerId: adapter.id, projectId: project.id })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ providerId: adapter.id })]
    });
    await expect(app.providers.importSessions({ providerId: adapter.id, projectId: project.id })).resolves.toMatchObject({
      importedSessionIds: expect.any(Array)
    });

    const eventTypes = (await app.events.queryEvents({ providerId: adapter.id })).map((event) => event.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "provider.client.started",
        "agent.session.started",
        "agent.turn.started",
        "agent.command.started",
        "agent.command.output",
        "agent.command.completed",
        "agent.fileChange.proposed",
        "agent.turn.completed",
        "provider.rawEvent",
        "agent.turn.interrupted"
      ])
    );
    expect(app.snapshot().projects[project.id]?.sessions[sessionId]?.providerSessionRef?.externalId).toBe("thread-1");
    expect(app.snapshot().projects[project.id]?.sessions[sessionId]?.providerSessionRef?.externalId).not.toBe(sessionId);
  });

  it("persists approval decisions before forwarding command and file decisions", async () => {
    const command = await createFakeCodexAppServer({ scenario: "approval" });
    const adapter = createCodexAdapter({ id: providerId("codex-app-server-approval"), command, args: ["app-server"] });
    const app = await createPraxisApp({ providerAdapters: [adapter] });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: adapter.id, projectId: project.id, cwd: rootPath });

    await app.providers.sendTurn({ providerId: adapter.id, projectId: project.id, sessionId, instruction: "Run tests" });
    const approval = app.snapshot().approvals.pending[0]!;
    expect(approval).toMatchObject({ kind: "command", providerId: adapter.id, risk: "high" });
    await app.providers.decideApproval({ providerId: adapter.id, approvalId: approval.id, decision: "accept_once" });

    const events = await app.events.queryEvents({ providerId: adapter.id });
    const acceptedIndex = events.findIndex((event) => event.type === "approval.accepted");
    const commandIndex = events.findIndex((event) => event.type === "agent.command.completed");
    expect(acceptedIndex).toBeGreaterThanOrEqual(0);
    expect(commandIndex).toBeGreaterThan(acceptedIndex);
    expect(app.snapshot().approvals.history[0]).toMatchObject({ id: approval.id, status: "accepted" });

    const fileCommand = await createFakeCodexAppServer({ scenario: "file_approval" });
    const fileAdapter = createCodexAdapter({ id: providerId("codex-app-server-file-approval"), command: fileCommand, args: ["app-server"] });
    const fileApp = await createPraxisApp({ providerAdapters: [fileAdapter] });
    const fileProject = await fileApp.projects.registerProject({ rootPath });
    const fileSessionId = await fileApp.providers.startSession({ providerId: fileAdapter.id, projectId: fileProject.id, cwd: rootPath });
    await fileApp.providers.sendTurn({ providerId: fileAdapter.id, projectId: fileProject.id, sessionId: fileSessionId, instruction: "Edit" });
    expect(fileApp.snapshot().approvals.pending[0]).toMatchObject({ kind: "file_change" });
  });

  it("maps user-input requests and fails closed on unsafe unsupported approval scopes", async () => {
    const userInputCommand = await createFakeCodexAppServer({ scenario: "user_input" });
    const userInputAdapter = createCodexAdapter({ id: providerId("codex-app-server-user-input"), command: userInputCommand, args: ["app-server"] });
    const app = await createPraxisApp({ providerAdapters: [userInputAdapter] });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: userInputAdapter.id, projectId: project.id, cwd: rootPath });
    const turnId = await app.providers.sendTurn({ providerId: userInputAdapter.id, projectId: project.id, sessionId, instruction: "Ask" });

    expect(app.snapshot().projects[project.id]?.sessions[sessionId]?.state).toBe("waiting_for_user_input");
    await app.providers.respondToUserInput({ providerId: userInputAdapter.id, sessionId, turnId, input: "Use the durable path." });
    expect(app.snapshot().projects[project.id]?.turns[turnId]?.status).toBe("completed");

    const unsafeCommand = await createFakeCodexAppServer({ scenario: "unsafe_scope" });
    const unsafeAdapter = createCodexAdapter({ id: providerId("codex-app-server-unsafe"), command: unsafeCommand, args: ["app-server"] });
    const unsafeApp = await createPraxisApp({ providerAdapters: [unsafeAdapter] });
    const unsafeProject = await unsafeApp.projects.registerProject({ rootPath });
    const unsafeSessionId = await unsafeApp.providers.startSession({ providerId: unsafeAdapter.id, projectId: unsafeProject.id, cwd: rootPath });
    await unsafeApp.providers.sendTurn({ providerId: unsafeAdapter.id, projectId: unsafeProject.id, sessionId: unsafeSessionId, instruction: "Unsafe" });

    expect(unsafeApp.snapshot().approvals.pending).toHaveLength(0);
    expect((await unsafeApp.events.queryEvents({ providerId: unsafeAdapter.id })).some((event) => event.type === "provider.error")).toBe(true);
  });

  it("maps protocol errors into provider-neutral turn failures", async () => {
    const errorCommand = await createFakeCodexAppServer({ scenario: "error" });
    const errorAdapter = createCodexAdapter({ id: providerId("codex-app-server-error"), command: errorCommand, args: ["app-server"] });
    const errorApp = await createPraxisApp({ providerAdapters: [errorAdapter] });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await errorApp.projects.registerProject({ rootPath });
    const sessionId = await errorApp.providers.startSession({ providerId: errorAdapter.id, projectId: project.id, cwd: rootPath });
    const turnId = await errorApp.providers.sendTurn({ providerId: errorAdapter.id, projectId: project.id, sessionId, instruction: "Overflow" });

    expect(errorApp.snapshot().projects[project.id]?.turns[turnId]?.status).toBe("failed");
    expect((await errorApp.events.queryEvents({ providerId: errorAdapter.id })).some((event) => JSON.stringify(event.payload).includes("ContextWindowExceeded"))).toBe(true);
  });

  it("retries bounded overload errors", async () => {
    const overloadCommand = await createFakeCodexAppServer({ scenario: "overload" });
    const overloadAdapter = createCodexAdapter({
      id: providerId("codex-app-server-overload"),
      command: overloadCommand,
      args: ["app-server"],
      maxOverloadRetries: 1
    });
    const overloadApp = await createPraxisApp({ providerAdapters: [overloadAdapter] });
    const rootPath = await createTempProject({ packageJson: false });
    const overloadProject = await overloadApp.projects.registerProject({ rootPath });
    const overloadSession = await overloadApp.providers.startSession({ providerId: overloadAdapter.id, projectId: overloadProject.id, cwd: rootPath });
    const overloadTurn = await overloadApp.providers.sendTurn({ providerId: overloadAdapter.id, projectId: overloadProject.id, sessionId: overloadSession, instruction: "Retry" });
    expect(overloadApp.snapshot().projects[overloadProject.id]?.turns[overloadTurn]?.status).toBe("completed");
  });

  it("recovers after provider crash and restart", async () => {
    const crashMarker = path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-codex-crash-marker-")), "crashed");
    const crashCommand = await createFakeCodexAppServer({ scenario: "crash_once" });
    const crashAdapter = createCodexAdapter({
      id: providerId("codex-app-server-crash"),
      command: crashCommand,
      args: ["app-server"],
      env: { PRAXIS_FAKE_CODEX_CRASH_MARKER: crashMarker }
    });
    const crashApp = await createPraxisApp({ providerAdapters: [crashAdapter] });
    const rootPath = await createTempProject({ packageJson: false });
    const crashProject = await crashApp.projects.registerProject({ rootPath });
    const crashSession = await crashApp.providers.startSession({ providerId: crashAdapter.id, projectId: crashProject.id, cwd: rootPath });
    const failedTurn = await crashApp.providers.sendTurn({ providerId: crashAdapter.id, projectId: crashProject.id, sessionId: crashSession, instruction: "Crash" });
    expect(crashApp.snapshot().projects[crashProject.id]?.turns[failedTurn]?.status).toBe("failed");
    const restartedTurn = await crashApp.providers.sendTurn({ providerId: crashAdapter.id, projectId: crashProject.id, sessionId: crashSession, instruction: "Restart" });
    expect(crashApp.snapshot().projects[crashProject.id]?.turns[restartedTurn]?.status).toBe("completed");
  });

  it("classifies every used app-server feature and keeps unsupported features gated", () => {
    expect(codexFeatureMatrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "thread/start", classification: "A", status: "implemented" }),
        expect.objectContaining({ method: "turn/start", classification: "A", status: "implemented" }),
        expect.objectContaining({ method: "process/*", classification: "D", status: "unsupported" }),
        expect.objectContaining({ method: "review/start", classification: "B", status: "unsupported" })
      ])
    );
  });
});

describe("CodexJsonRpcClient", () => {
  it("handles JSON-RPC notifications, server requests, invalid JSON, and timeouts", async () => {
    const command = await createFakeCodexAppServer({ scenario: "raw_and_timeout" });
    const notifications: unknown[] = [];
    const requests: unknown[] = [];
    const client = new CodexJsonRpcClient({
      command,
      args: ["app-server"],
      requestTimeoutMs: 1_000,
      onNotification: (message) => notifications.push(message),
      onServerRequest: (message) => requests.push(message)
    });

    await expect(client.request("initialize", {})).resolves.toEqual({ ok: true });
    await expect(client.request("never/responds", {})).rejects.toThrow(/timed out/);
    expect(notifications).toEqual(expect.arrayContaining([expect.objectContaining({ method: "provider.rawEvent" })]));
    expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ method: "tool/requestUserInput" })]));
    client.stop();
  });
});

type FakeServerOptions = {
  version?: string;
  scenario?: "default" | "approval" | "file_approval" | "user_input" | "unsafe_scope" | "error" | "overload" | "crash_once" | "raw_and_timeout";
};

function createCodexAdapter(options: ConstructorParameters<typeof CodexAppServerProviderAdapter>[0]): CodexAppServerProviderAdapter {
  const adapter = new CodexAppServerProviderAdapter(options);
  trackedAdapters.add(adapter);
  return adapter;
}

async function createFakeCodexAppServer(options: FakeServerOptions = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "praxis-codex-app-server-"));
  const scriptPath = path.join(dir, "fake-codex-app-server.mjs");
  await writeFile(scriptPath, fakeServerSource(options), { mode: 0o755 });
  return scriptPath;
}

function fakeServerSource(options: FakeServerOptions): string {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const version = ${JSON.stringify(options.version ?? "0.2.0")};
const scenario = ${JSON.stringify(options.scenario ?? "default")};
if (process.argv.includes('--version')) {
  console.log('codex ' + version);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
let threadCounter = 0;
let turnCounter = 0;
let overloaded = false;
const pendingRequests = new Map();

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
}
function result(id, value = {}) { send({ id, result: value }); }
function notify(method, params = {}) { send({ method, params }); }
function serverRequest(id, method, params = {}) {
  pendingRequests.set(String(id), { method, params });
  send({ id, method, params });
}
function threadId() { return 'thread-1'; }
function turnId() { return 'turn-' + turnCounter; }

rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if ('id' in message && !message.method) {
    const pending = pendingRequests.get(String(message.id));
    if (pending?.method === 'commandExecution/approval' || pending?.method === 'fileChange/approval') {
      notify('item/started', { threadId: threadId(), turnId: turnId(), item: { id: 'cmd-1', type: 'commandExecution', command: ['npm', 'test'], cwd: '.' } });
      notify('command/output/delta', { threadId: threadId(), turnId: turnId(), itemId: 'cmd-1', stdout: 'ok' });
      notify('item/completed', { threadId: threadId(), turnId: turnId(), item: { id: 'cmd-1', type: 'commandExecution', command: ['npm', 'test'], exitCode: 0 } });
      notify('turn/completed', { threadId: threadId(), turnId: turnId(), status: 'completed', result: 'done' });
    }
    if (pending?.method === 'tool/requestUserInput') {
      notify('item/agentMessage/delta', { threadId: threadId(), turnId: turnId(), text: 'input received' });
      notify('turn/completed', { threadId: threadId(), turnId: turnId(), status: 'completed', result: 'input done' });
    }
    pendingRequests.delete(String(message.id));
    return;
  }

  switch (message.method) {
    case 'initialize':
      if (scenario === 'raw_and_timeout') {
        process.stdout.write('not-json\\n');
        serverRequest('input-1', 'tool/requestUserInput', { threadId: threadId(), prompt: 'Need input' });
      }
      result(message.id, { ok: true });
      break;
    case 'never/responds':
      break;
    case 'thread/start':
      threadCounter += 1;
      result(message.id, { threadId: threadId() });
      break;
    case 'thread/resume':
      notify('thread/status/changed', { threadId: message.params.threadId, status: 'active' });
      result(message.id, {});
      break;
    case 'thread/read':
      result(message.id, { thread: { id: message.params.threadId, cwd: '.', goal: 'read' } });
      break;
    case 'thread/list':
      result(message.id, { threads: [{ id: 'thread-listed', cwd: '.' }] });
      break;
    case 'thread/unsubscribe':
      notify('thread/closed', { threadId: message.params.threadId });
      result(message.id, {});
      break;
    case 'turn/steer':
      notify('item/agentMessage/delta', { threadId: message.params.threadId, turnId: message.params.turnId, text: message.params.input });
      result(message.id, {});
      break;
    case 'turn/interrupt':
      result(message.id, {});
      break;
    case 'turn/start':
      if (scenario === 'crash_once' && process.env.PRAXIS_FAKE_CODEX_CRASH_MARKER && !fs.existsSync(process.env.PRAXIS_FAKE_CODEX_CRASH_MARKER)) {
        fs.writeFileSync(process.env.PRAXIS_FAKE_CODEX_CRASH_MARKER, 'crashed');
        process.exit(2);
      }
      if (scenario === 'error') {
        send({ id: message.id, error: { code: -32000, message: 'ContextWindowExceeded', data: { type: 'ContextWindowExceeded' } } });
        break;
      }
      if (scenario === 'overload' && !overloaded) {
        overloaded = true;
        send({ id: message.id, error: { code: 429, message: 'ResponseTooManyFailedAttempts', data: { type: 'ResponseTooManyFailedAttempts' } } });
        break;
      }
      turnCounter += 1;
      notify('turn/started', { threadId: message.params.threadId, turnId: turnId(), inputSummary: message.params.input });
      if (scenario === 'approval') {
        serverRequest('approval-1', 'commandExecution/approval', { threadId: message.params.threadId, turnId: turnId(), command: ['npm', 'test'], cwd: '.' });
        result(message.id, { turnId: turnId() });
        break;
      }
      if (scenario === 'file_approval') {
        serverRequest('approval-1', 'fileChange/approval', { threadId: message.params.threadId, turnId: turnId(), path: 'src/example.ts', diff: '--- old' });
        result(message.id, { turnId: turnId() });
        break;
      }
      if (scenario === 'user_input') {
        serverRequest('input-1', 'tool/requestUserInput', { threadId: message.params.threadId, turnId: turnId(), title: 'Clarify task', prompt: 'Which path?' });
        result(message.id, { turnId: turnId() });
        break;
      }
      if (scenario === 'unsafe_scope') {
        serverRequest('approval-1', 'commandExecution/approval', { command: ['rm', '-rf', '/tmp/x'] });
        result(message.id, { turnId: turnId() });
        break;
      }
      notify('item/started', { threadId: message.params.threadId, turnId: turnId(), item: { id: 'cmd-1', type: 'commandExecution', command: ['npm', 'test'], cwd: '.' } });
      notify('command/output/delta', { threadId: message.params.threadId, turnId: turnId(), itemId: 'cmd-1', stdout: 'running' });
      notify('item/completed', { threadId: message.params.threadId, turnId: turnId(), item: { id: 'cmd-1', type: 'commandExecution', command: ['npm', 'test'], exitCode: 0, stdout: 'ok' } });
      notify('turn/diff/updated', { threadId: message.params.threadId, turnId: turnId(), files: [{ id: 'file-1', path: 'src/example.ts', changeKind: 'modified', diff: '--- old' }] });
      notify('turn/plan/updated', { threadId: message.params.threadId, turnId: turnId(), text: 'Plan updated' });
      notify('thread/tokenUsage/updated', { threadId: message.params.threadId, turnId: turnId(), inputTokens: 1, outputTokens: 2 });
      notify('mcpToolCall/updated', { threadId: message.params.threadId, turnId: turnId(), name: 'tool' });
      notify('webSearch/updated', { threadId: message.params.threadId, turnId: turnId(), query: 'docs' });
      notify('imageView/updated', { threadId: message.params.threadId, turnId: turnId(), path: 'image.png' });
      notify('provider/unknownNotification', { threadId: message.params.threadId, secret: 'sk-1234567890abcdef' });
      notify('turn/completed', { threadId: message.params.threadId, turnId: turnId(), status: 'completed', result: 'done' });
      result(message.id, { turnId: turnId() });
      break;
    default:
      result(message.id, {});
  }
});
`;
}
