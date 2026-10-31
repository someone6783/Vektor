import type { RunEvent, RunStatus, RunUsage } from "@vektor/shared";

export interface LiveToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LiveRun {
  runId: string;
  text: string;
  status: RunStatus;
  usage: RunUsage | null;
  tools: LiveToolCall[];
  lastSeq: number;
}

export function startLiveRun(runId: string): LiveRun {
  return {
    runId,
    text: "",
    status: "running",
    usage: null,
    tools: [],
    lastSeq: 0,
  };
}

export function applyRunEvent(live: LiveRun, event: RunEvent): LiveRun {
  if (event.runId !== live.runId) {
    return live;
  }

  const next: LiveRun = { ...live, lastSeq: Math.max(live.lastSeq, event.seq) };

  switch (event.type) {
    case "run.started":
      return { ...next, status: "running" };
    case "message.delta":
      return { ...next, text: live.text + event.text };
    case "tool.requested":
      return {
        ...next,
        tools: [...live.tools, { id: event.toolCallId, name: event.name, input: event.input }],
      };
    case "usage":
      return {
        ...next,
        usage: {
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        },
      };
    case "run.completed":
      return { ...next, status: "completed" };
    case "run.failed":
      return { ...next, status: "failed" };
    case "run.cancelled":
      return { ...next, status: "cancelled" };
    default:
      return next;
  }
}

export function isTerminalStatus(status: RunStatus): boolean {
  return status !== "running";
}
