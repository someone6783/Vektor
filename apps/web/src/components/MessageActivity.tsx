import { memo, useEffect, useState } from "react";
import type { ApiClient } from "../lib/api";
import { applyRunEvent, startLiveRun, type LiveRun, type LiveToolCall } from "../lib/live";
import type { RunDetails } from "@vektor/shared";
import { visibleRunBlocks } from "../lib/useStreamedText";
import { Markdown } from "./Markdown";
import { Icon } from "./Icon";
import { ToolDetails } from "./ToolDetails";

const TextBlock = memo(Markdown);

const browserActions: Record<string, string> = {
  navigate: "Open page",
  snapshot: "Read page",
  screenshot: "Take screenshot",
  tabs: "List tabs",
  new_tab: "Open tab",
  select_tab: "Switch tab",
  close_tab: "Close tab",
  click: "Click element",
  fill: "Fill field",
  scroll: "Scroll page",
  wait: "Wait",
  upload: "Upload file",
  download: "Download file",
};
const toolStatuses: Record<string, string> = {
  completed: "Completed",
  running: "Running",
  requested: "Queued",
  waiting: "Awaiting approval",
  failed: "Failed",
  denied: "Denied",
  cancelled: "Stopped",
};

const ToolCallRow = memo(function ToolCallRow({ tool }: { tool: LiveToolCall }) {
  const input =
    tool.input && typeof tool.input === "object" ? (tool.input as Record<string, unknown>) : {};
  const browser = tool.name.startsWith("browser");
  const terminal = tool.name === "terminal";
  const action = typeof input.action === "string" ? input.action : tool.name.split(".")[1];
  const label = browser
    ? (browserActions[action ?? ""] ?? "Browser")
    : terminal
      ? "Run command"
      : tool.name;
  const status = toolStatuses[tool.status] ?? tool.status;
  let hint = "";
  if (typeof input.url === "string") {
    try {
      const url = new URL(input.url);
      hint = url.host + (url.pathname === "/" ? "" : url.pathname);
    } catch {
      hint = input.url;
    }
  } else if (terminal && typeof input.command === "string") {
    hint = [
      input.command,
      ...(Array.isArray(input.args) ? input.args.filter((arg) => typeof arg === "string") : []),
    ].join(" ");
  } else if (action === "wait" && typeof input.ms === "number") hint = `${input.ms / 1000}s`;
  return (
    <li>
      <details className="tool-call" data-status={tool.status}>
        <summary
          className="tool-call-summary"
          title={tool.name}
          aria-label={`${label} · ${status}`}
        >
          <span className="tool-call-icon">
            <Icon name={browser ? "browser" : terminal ? "terminal" : "connection"} />
          </span>
          <span className="tool-call-label">{label}</span>
          <span className="tool-call-hint" title={hint}>
            {hint}
          </span>
          <span className="tool-call-status">
            <span className="tool-call-status-dot" />
            {status}
          </span>
          <svg
            className="tool-call-chevron"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path d="m9 5 7 7-7 7" />
          </svg>
        </summary>
        <div className="tool-call-body">
          <ToolDetails tool={tool} />
        </div>
      </details>
    </li>
  );
});

export function ToolActivity({ tools }: { tools: LiveToolCall[] }) {
  if (!tools.length) return null;
  return (
    <ol aria-label="Tool calls" className="tool-call-list">
      {tools.map((tool) => (
        <ToolCallRow key={tool.id} tool={tool} />
      ))}
    </ol>
  );
}

const ThinkingBlock = memo(function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="thinking-block" open>
      <summary>
        <Icon name="chat" />
        <span>Thinking</span>
      </summary>
      <div className="thinking-content">
        {text ? <TextBlock>{text}</TextBlock> : <span className="tool-empty">Thinking…</span>}
      </div>
    </details>
  );
});

export function RunContent({ live, chunked = false }: { live: LiveRun; chunked?: boolean }) {
  const tools = new Map(live.tools.map((tool) => [tool.id, tool]));
  return (
    <div className="run-content">
      {visibleRunBlocks(live, chunked).map((block) => {
        if (block.type === "text")
          return block.text ? <TextBlock key={block.id}>{block.text}</TextBlock> : null;
        if (block.type === "thinking") return <ThinkingBlock key={block.id} text={block.text} />;
        const tool = tools.get(block.id);
        return tool ? <ToolActivity key={block.id} tools={[tool]} /> : null;
      })}
    </div>
  );
}

export function MessageActivity({
  client,
  runId,
  content = "",
}: {
  client: ApiClient;
  runId: string;
  content?: string;
}) {
  const [details, setDetails] = useState<RunDetails | null>(null);
  useEffect(() => {
    let active = true;
    setDetails(null);
    void client
      .runDetails(runId, true)
      .then((result) => {
        if (active) setDetails(result);
      })
      .catch(() => {
        /* Keep the saved message readable if activity is unavailable. */
      });
    return () => {
      active = false;
    };
  }, [client, runId]);
  const replay = details?.transcript?.reduce(applyRunEvent, startLiveRun(runId));
  if (replay && replay.blocks.length && replay.text === content) {
    return <RunContent live={{ ...replay, status: "completed", tools: details!.tools }} />;
  }
  return (
    <>
      {content ? <TextBlock>{content}</TextBlock> : null}
      {details ? <ToolActivity tools={details.tools} /> : null}
    </>
  );
}
