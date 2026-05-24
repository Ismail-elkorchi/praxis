import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { providerId } from "../src/core";

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "praxis-example-"));
await writeFile(
  path.join(projectRoot, "package.json"),
  JSON.stringify(
    {
      scripts: {
        test: "node -e \"process.exit(0)\""
      }
    },
    null,
    2
  )
);

const app = await createPraxisApp({ fakeScenario: "approval_path" });
const fakeProviderId = providerId("fake");
const project = await app.projects.registerProject({
  rootPath: projectRoot,
  name: "Example project",
  defaultProviderId: fakeProviderId
});

const sessionId = await app.providers.startSession({
  providerId: fakeProviderId,
  projectId: project.id,
  cwd: projectRoot,
  goal: "Demonstrate a fake-provider workflow"
});

const turnId = await app.providers.sendTurn({
  providerId: fakeProviderId,
  projectId: project.id,
  sessionId,
  instruction: "Run the project check"
});

const modeBeforeDecision = app.snapshot().dashboard.mode;
const approval = app.snapshot().approvals.pending[0];
if (!approval) {
  throw new Error("Expected the fake provider to request an approval.");
}

await app.providers.decideApproval({
  providerId: fakeProviderId,
  approvalId: approval.id,
  decision: "accept_once"
});

const snapshot = app.snapshot();
const projectSnapshot = snapshot.projects[project.id];
const events = await app.events.queryEvents();

console.log(
  JSON.stringify(
    {
      project: {
        name: project.name,
        scriptNames: project.scripts.map((script) => script.name)
      },
      providerStatuses: snapshot.dashboard.providerStatus.map((provider) => ({
        name: provider.name,
        status: provider.availability.status
      })),
      realProviderCount: app.providerRegistry.listRealProviders().length,
      sessionId,
      turnId,
      modeBeforeDecision,
      modeAfterDecision: snapshot.dashboard.mode,
      pendingApprovals: snapshot.approvals.pending.length,
      approvalHistory: snapshot.approvals.history.map((item) => ({
        kind: item.kind,
        risk: item.risk,
        status: item.status
      })),
      commandRuns: projectSnapshot?.commandRuns.map((run) => ({
        command: run.command,
        status: run.status,
        exitCode: run.exitCode
      })),
      eventTypes: events.map((event) => event.type)
    },
    null,
    2
  )
);

app.eventStore.close?.();
