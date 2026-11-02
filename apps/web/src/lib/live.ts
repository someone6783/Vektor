import type { RunEvent, RunStatus, RunUsage } from "@vektor/shared";

export interface LiveToolCall {
  id: string;
  name: string;
  input?: unknown;
  status: string;
  output?: string;
  progress?: string;
}

export interface LiveRun {
  runId: string;
  text: string;
  status: RunStatus;
  usage: RunUsage | null;
  tools: LiveToolCall[];
  lastSeq: number;
  phase: "thinking" | "responding" | "tools";
  blocks: Array<
    { type: "text" | "thinking"; id: string; text: string } | { type: "tool"; id: string }
  >;
}

export function startLiveRun(runId: string): LiveRun {
  return {
    runId,
    text: "",
    status: "running",
    usage: null,
    tools: [],
    lastSeq: 0,
    phase: "thinking",
    blocks: [],
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
    case "reasoning.delta": {
      const type: "text" | "thinking" = event.type === "message.delta" ? "text" : "thinking";
      const last = live.blocks.at(-1);
      const blocks =
        last?.type === type
          ? [...live.blocks.slice(0, -1), { ...last, text: last.text + event.text }]
          : [...live.blocks, { type, id: `${type}-${event.seq}`, text: event.text }];
      return {
        ...next,
        text: type === "text" ? live.text + event.text : live.text,
        phase: type === "text" ? "responding" : "thinking",
        blocks,
      };
    }
    case "tool.requested":
      return {
        ...next,
        phase: "tools",
        blocks: [...live.blocks, { type: "tool", id: event.toolCallId }],
        tools: [
          ...live.tools,
          { id: event.toolCallId, name: event.name, input: event.input, status: "running" },
        ],
      };
    case "approval.requested":
      return {
        ...next,
        tools: live.tools.map((tool) =>
          tool.id === event.toolCallId ? { ...tool, status: "waiting" } : tool,
        ),
      };
    case "tool.progress":
      return {
        ...next,
        phase: "tools",
        tools: live.tools.map((tool) =>
          tool.id === event.toolCallId
            ? { ...tool, status: "running", progress: JSON.stringify(event.detail) }
            : tool,
        ),
      };
    case "tool.output": {
      const tools = live.tools.map((tool) =>
        tool.id === event.toolCallId
          ? { ...tool, status: event.isError ? "failed" : "completed", output: event.output }
          : tool,
      );
      return {
        ...next,
        tools,
        phase: tools.some((tool) => ["running", "waiting"].includes(tool.status))
          ? "tools"
          : "thinking",
      };
    }
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
