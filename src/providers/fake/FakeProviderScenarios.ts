export type FakeProviderScenarioName =
  | "happy_path"
  | "approval_path"
  | "file_change_path"
  | "failure_path"
  | "user_input_path"
  | "stale_path"
  | "unknown_event_path"
  | "unavailable_path";

export type FakeProviderScenario = {
  name: FakeProviderScenarioName;
  unavailable?: boolean;
};

export const fakeProviderScenarios: Record<FakeProviderScenarioName, FakeProviderScenario> = {
  happy_path: { name: "happy_path" },
  approval_path: { name: "approval_path" },
  file_change_path: { name: "file_change_path" },
  failure_path: { name: "failure_path" },
  user_input_path: { name: "user_input_path" },
  stale_path: { name: "stale_path" },
  unknown_event_path: { name: "unknown_event_path" },
  unavailable_path: { name: "unavailable_path", unavailable: true }
};
