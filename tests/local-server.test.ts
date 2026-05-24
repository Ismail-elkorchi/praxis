import { once } from "node:events";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { createLocalServer } from "../src/server/createLocalServer";
import { createTempProject } from "./helpers/tempProject";

describe("local API and WebSocket server", () => {
  it("serves health, API requests, and dashboard snapshot pushes", async () => {
    const app = await createPraxisApp();
    const { server, sockets } = createLocalServer({ app });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const pushes: unknown[] = [];
    try {
      socket.on("message", (message) => pushes.push(JSON.parse(String(message))));
      await once(socket, "open");
      await waitFor(() => pushes.some((push) => isDashboardPush(push)));

      await expect(fetch(`${baseUrl}/health`).then((response) => response.json())).resolves.toEqual({ ok: true });

      const rootPath = await createTempProject({ packageJson: false });
      const response = await fetch(`${baseUrl}/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "register", method: "projects.register", params: { rootPath } })
      });
      await expect(response.json()).resolves.toMatchObject({ id: "register" });
      await waitFor(() => pushes.filter((push) => isDashboardPush(push)).length >= 2);

      app.fakeProvider.setScenario("unavailable_path");
      const availabilityResponse = await fetch(`${baseUrl}/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "availability",
          method: "providers.checkAvailability",
          params: { providerId: providerId("fake") }
        })
      });
      await expect(availabilityResponse.json()).resolves.toMatchObject({
        id: "availability",
        result: { status: "unavailable" }
      });
      await waitFor(() => pushes.some((push) => isPushChannel(push, "provider.statusChanged")));
    } finally {
      socket.terminate();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it("pushes approval request channels from emitted events", async () => {
    const app = await createPraxisApp({ fakeScenario: "approval_path" });
    const { server, sockets } = createLocalServer({ app });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const pushes: unknown[] = [];
    try {
      socket.on("message", (message) => pushes.push(JSON.parse(String(message))));
      await once(socket, "open");
      await waitFor(() => pushes.some((push) => isDashboardPush(push)));

      const rootPath = await createTempProject({ packageJson: false });
      const project = await postApi<{ id: string }>(baseUrl, {
        id: "register",
        method: "projects.register",
        params: { rootPath }
      });
      const sessionId = await postApi<string>(baseUrl, {
        id: "start-session",
        method: "agents.startSession",
        params: {
          providerId: providerId("fake"),
          projectId: project.id,
          cwd: rootPath,
          goal: "Exercise approval push"
        }
      });
      await postApi<string>(baseUrl, {
        id: "send-turn",
        method: "agents.sendTurn",
        params: {
          providerId: providerId("fake"),
          projectId: project.id,
          sessionId,
          instruction: "Request approval"
        }
      });

      await waitFor(() => pushes.some((push) => isPushChannel(push, "approval.requested")));
      const approvalPush = pushes.find((push) => isPushChannel(push, "approval.requested"));
      expect(dashboardApprovalCount(approvalPush)).toBe(1);
    } finally {
      socket.terminate();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});

async function postApi<T>(
  baseUrl: string,
  request: { id: string; method: string; params?: unknown }
): Promise<T> {
  const response = await fetch(`${baseUrl}/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (!response.ok || "error" in body) {
    throw new Error(JSON.stringify(body.error ?? body));
  }
  return body.result as T;
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for assertion.");
}

function isDashboardPush(value: unknown): boolean {
  return isPushChannel(value, "dashboard.snapshotChanged");
}

function isPushChannel(value: unknown, channel: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "push" &&
    "channel" in value &&
    value.channel === channel
  );
}

function dashboardApprovalCount(value: unknown): number {
  if (typeof value !== "object" || value === null || !("data" in value)) return 0;
  const data = value.data;
  if (typeof data !== "object" || data === null || !("approvals" in data)) return 0;
  return Array.isArray(data.approvals) ? data.approvals.length : 0;
}
