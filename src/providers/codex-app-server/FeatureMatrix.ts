export type CodexFeatureClassification = "A" | "B" | "C" | "D" | "E";

export type CodexFeatureMatrixEntry = {
  method: string;
  classification: CodexFeatureClassification;
  status: "implemented" | "adapter_local" | "gated" | "unsupported";
  mapsTo: string;
  notes: string;
};

export const codexFeatureMatrix: CodexFeatureMatrixEntry[] = [
  {
    method: "initialize",
    classification: "C",
    status: "adapter_local",
    mapsTo: "Provider availability, compatibility, diagnostics",
    notes: "Transport handshake stays inside the adapter."
  },
  {
    method: "initialized",
    classification: "C",
    status: "adapter_local",
    mapsTo: "Provider lifecycle",
    notes: "Sent by the adapter unless notifications are explicitly opted out."
  },
  {
    method: "thread/start",
    classification: "A",
    status: "implemented",
    mapsTo: "AgentSession + ProviderSessionRef",
    notes: "External thread ids are stored only in provider references and adapter-local state."
  },
  {
    method: "thread/resume",
    classification: "A",
    status: "implemented",
    mapsTo: "resumeSession",
    notes: "Uses adapter-local session reference mapping."
  },
  {
    method: "thread/read",
    classification: "A",
    status: "implemented",
    mapsTo: "readSession",
    notes: "Returns provider-neutral session snapshots and normalized events."
  },
  {
    method: "thread/list",
    classification: "A",
    status: "implemented",
    mapsTo: "listSessions/importSessions",
    notes: "Creates Praxis-owned session ids for imported snapshots."
  },
  {
    method: "thread/loaded/list",
    classification: "C",
    status: "adapter_local",
    mapsTo: "diagnostics/capability matrix",
    notes: "Detected for diagnostics only in this milestone."
  },
  {
    method: "thread/unsubscribe",
    classification: "A",
    status: "implemented",
    mapsTo: "stopSession",
    notes: "Used as safe detach/stop semantics."
  },
  {
    method: "turn/start",
    classification: "A",
    status: "implemented",
    mapsTo: "AgentTurn",
    notes: "Turn identity remains Praxis-owned."
  },
  {
    method: "turn/steer",
    classification: "A",
    status: "implemented",
    mapsTo: "steerTurn",
    notes: "Requires an active Praxis turn id."
  },
  {
    method: "turn/interrupt",
    classification: "A",
    status: "implemented",
    mapsTo: "interruptTurn",
    notes: "Maps to interrupted turn state."
  },
  {
    method: "command/approval",
    classification: "A",
    status: "implemented",
    mapsTo: "ApprovalRequest(kind=command|network)",
    notes: "Decisions are persisted by Praxis before forwarding."
  },
  {
    method: "fileChange/approval",
    classification: "A",
    status: "implemented",
    mapsTo: "ApprovalRequest(kind=file_change)",
    notes: "Unknown or unsafe request shapes fail closed."
  },
  {
    method: "tool/requestUserInput",
    classification: "A",
    status: "implemented",
    mapsTo: "agent.userInput.requested/responded",
    notes: "Responses are persisted by Praxis before forwarding."
  },
  {
    method: "model/list",
    classification: "C",
    status: "adapter_local",
    mapsTo: "capability matrix",
    notes: "Not promoted to core until a provider-neutral model catalog is needed."
  },
  {
    method: "configRequirements/read",
    classification: "C",
    status: "adapter_local",
    mapsTo: "diagnostics/capability matrix",
    notes: "No provider-neutral configuration model is added in this milestone."
  },
  {
    method: "config/read",
    classification: "C",
    status: "adapter_local",
    mapsTo: "diagnostics/capability matrix",
    notes: "Kept out of global UI and core settings."
  },
  {
    method: "skills/list",
    classification: "C",
    status: "adapter_local",
    mapsTo: "capability matrix",
    notes: "No provider-neutral tool catalog is introduced in this PR."
  },
  {
    method: "app/list",
    classification: "C",
    status: "adapter_local",
    mapsTo: "capability matrix",
    notes: "No provider-neutral app catalog is introduced in this PR."
  },
  {
    method: "process/*",
    classification: "D",
    status: "unsupported",
    mapsTo: "unsupported/gated capability",
    notes: "Unsafe process control is not exposed by default."
  },
  {
    method: "thread/shellCommand",
    classification: "D",
    status: "unsupported",
    mapsTo: "unsupported/gated capability",
    notes: "General shell command UI is intentionally not implemented."
  },
  {
    method: "thread/inject_items",
    classification: "D",
    status: "unsupported",
    mapsTo: "unsupported/gated capability",
    notes: "Item injection is experimental and not needed for this milestone."
  },
  {
    method: "dynamicTools",
    classification: "D",
    status: "unsupported",
    mapsTo: "unsupported/gated capability",
    notes: "Dynamic tool exposure requires a future provider-neutral safety model."
  },
  {
    method: "command/exec",
    classification: "D",
    status: "unsupported",
    mapsTo: "unsupported/gated capability",
    notes: "Not exposed as a general UI feature."
  },
  {
    method: "review/start",
    classification: "B",
    status: "unsupported",
    mapsTo: "future ReviewRun/ReviewTarget/ReviewFinding",
    notes: "Not implemented because no provider-neutral review model exists yet."
  },
  {
    method: "thread goal set/get/clear",
    classification: "B",
    status: "unsupported",
    mapsTo: "AgentSession.goal or future TaskGoal",
    notes: "Not exposed as a provider-specific goal concept."
  }
];
