import type { ApprovalDecision } from "../core";
import type { DashboardProjection } from "../dashboard/types";

export type ApiStatus = "connecting" | "live" | "fallback";

type ClientRequest = {
  id: string;
  method: string;
  params?: unknown;
};

type ServerResponse<T> = { id: string; result: T } | { id: string; error: { code: string; message: string } };

export async function callApi<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
  const request: ClientRequest = { id: crypto.randomUUID(), method, params };
  const response = await fetch("/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal
  });
  if (!response.ok) {
    throw new Error(`API request failed with HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as ServerResponse<T>;
  if ("error" in payload) {
    throw new Error(payload.error.message);
  }
  return payload.result;
}

export function subscribeDashboard(onSnapshot: (snapshot: DashboardProjection) => void): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data)) as { type?: string; channel?: string; data?: unknown };
    if (payload.type === "push" && payload.channel === "dashboard.snapshotChanged") {
      onSnapshot(payload.data as DashboardProjection);
    }
  });
  return () => socket.close();
}

export async function decideApprovalThroughApi(input: {
  providerId: string;
  approvalId: string;
  decision: ApprovalDecision;
}): Promise<void> {
  await callApi("agents.respondToApproval", input);
}
