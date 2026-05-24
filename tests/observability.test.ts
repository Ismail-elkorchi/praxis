import { once } from "node:events";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { providerId } from "../src/core";
import { createDomainEvent } from "../src/events/eventFactory";
import { ObservabilityService } from "../src/observability/ObservabilityService";
import { createLocalServer } from "../src/server/createLocalServer";
import { createTempProject } from "./helpers/tempProject";

describe("observability diagnostics", () => {
  it("shows provider errors, event-id evidence, and measured ingestion latency", async () => {
    const app = await createPraxisApp();
    const rootPath = await createTempProject({ packageJson: false });
    await app.projects.registerProject({ rootPath });
    const registeredEvent = (await app.events.queryEvents()).find((event) => event.type === "project.registered");
    const delayedProviderError = createDomainEvent({
      type: "provider.error",
      providerId: providerId("fake"),
      source: "provider",
      timestamp: new Date(Date.now() - 5000).toISOString(),
      payload: { message: "Provider error TOKEN=secret-value" },
      evidence: []
    });

    await app.events.append(delayedProviderError);

    const diagnostics = await app.observability.diagnostics();
    expect(diagnostics.providerLog).toContainEqual(
      expect.objectContaining({
        eventId: delayedProviderError.id,
        level: "error",
        message: "Provider error [REDACTED]"
      })
    );
    expect(diagnostics.projectionInspector.evidenceEventIds).toContain(registeredEvent?.id);
    expect(diagnostics.metrics.providerEventIngestionLatencyMs.max).toBeGreaterThanOrEqual(4000);
    expect(diagnostics.replay.status).toBe("ok");
  });

  it("keeps raw provider logs disabled by default and redacts them when enabled", async () => {
    const app = await createPraxisApp();
    const rawEvent = createDomainEvent({
      type: "provider.rawEvent",
      providerId: providerId("fake"),
      source: "provider",
      payload: {
        accessToken: "never-show",
        line: "sk-1234567890abcdef"
      },
      evidence: []
    });

    await app.events.append(rawEvent);
    expect((await app.observability.diagnostics()).providerLog.some((entry) => entry.eventId === rawEvent.id)).toBe(false);

    app.settings.update({ rawProviderLogsEnabled: true }, { confirmRawProviderLogs: true });
    const diagnostics = await app.observability.diagnostics();
    const rawEntry = diagnostics.providerLog.find((entry) => entry.eventId === rawEvent.id);

    expect(rawEntry).toMatchObject({ raw: true, payload: { accessToken: "[REDACTED]", line: "[REDACTED]" } });
    expect(JSON.stringify(rawEntry)).not.toContain("never-show");
    expect(JSON.stringify(rawEntry)).not.toContain("sk-1234567890abcdef");
  });

  it("reports replay mismatches in diagnostics", async () => {
    const app = await createPraxisApp();
    const rootPath = await createTempProject({ packageJson: false });
    await app.projects.registerProject({ rootPath });
    const diagnostics = new ObservabilityService(app.events, app.settings, app.policies, () => ({
      ...app.snapshot(),
      dashboard: { ...app.snapshot().dashboard, mode: "active_work" }
    }));

    await expect(diagnostics.checkReplayHealth()).resolves.toMatchObject({
      status: "mismatch",
      differences: ["Live projection differs from event replay."]
    });
  });

  it("records local API latency through the server boundary", async () => {
    const app = await createPraxisApp();
    const { server, sockets } = createLocalServer({ app });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "dashboard", method: "dashboard.getSnapshot" })
      });
      await expect(response.json()).resolves.toMatchObject({ id: "dashboard" });

      const diagnostics = await app.observability.diagnostics();
      expect(diagnostics.metrics.apiLatencyMs.count).toBe(1);
      expect(diagnostics.metrics.apiLatencyMs.latest).toBeGreaterThanOrEqual(0);
    } finally {
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
