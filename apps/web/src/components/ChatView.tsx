import { ChoicePicker } from "./ChoicePicker";
import { ModelPicker } from "./ModelPicker";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChunkedStreaming } from "../lib/streamingPreference";
import { useStreamedText } from "../lib/useStreamedText";
import type {
  Channel,
  Message,
  ModelInfo,
  Profile,
  Run,
  ReasoningEffort,
  RunnerId,
  RunnerInstallationView,
} from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { ContextComposer } from "./ContextComposer";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { MessageAttachments } from "./Attachments";
import { RunTimeline } from "./RunTimeline";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { MessageActivity, RunContent } from "./MessageActivity";
import type { LiveRun } from "../lib/live";

interface ChatViewProps {
  queuedMessages?: ReactNode;
  reasoning?: ReasoningEffort;
  onReasoningChange?: (value: ReasoningEffort) => void;
  models?: ModelInfo[];
  onModelChange?: (model: string) => void;
  onExecutionSettings?: (section: "terminal" | "browser", runner?: RunnerId) => void;
  activeRunCount?: number;
  emergencyStopped?: boolean;
  client: ApiClient;
  lastRun: Run | null;
  channel: Channel | null;
  profile: Profile | null;
  messages: Message[];
  live: LiveRun | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  onSend: (
    content: string,
    attachmentIds: string[],
    allowTruncation: boolean,
    runner?: RunnerId,
    resumeFromRunId?: string,
    mcpContextIds?: string[],
  ) => Promise<void>;
  onStop: () => void;
  onRetry: (runId: string) => void;
  onLoadMore: () => void;
}

const statusLabel: Record<string, string> = {
  cancelled: "stopped",
  failed: "failed",
};

function MessageRow({
  message,
  client,
  onRetry,
  retryDisabled,
}: {
  message: Message;
  client: ApiClient;
  onRetry: (runId: string) => void;
  retryDisabled: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 ${
          isUser ? "message-user" : "message-assistant text-slate-200"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
        ) : (
          <>
            {message.runId ? (
              <MessageActivity client={client} runId={message.runId} content={message.content} />
            ) : message.content ? (
              <Markdown>{message.content}</Markdown>
            ) : null}
            {!message.content && !message.runId ? (
              <p className="text-sm italic text-slate-500">No output.</p>
            ) : null}
            {message.status !== "complete" ? (
              <p className="mt-2 text-[10px] uppercase tracking-wide text-rose-300">
                {statusLabel[message.status] ?? message.status}
              </p>
            ) : null}
          </>
        )}
        {message.attachments.length ? (
          <MessageAttachments files={message.attachments} client={client} />
        ) : null}
        {message.role === "assistant" && message.runId ? (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="message-action"
              disabled={retryDisabled}
              onClick={() => onRetry(message.runId!)}
            >
              <Icon name="refresh" /> Regenerate
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatView({
  queuedMessages,
  reasoning = "auto",
  onReasoningChange,
  models = [],
  onModelChange,
  onExecutionSettings,
  activeRunCount = 0,
  emergencyStopped = false,
  client,
  lastRun,
  channel,
  profile,
  messages,
  live,
  loading,
  loadingMore,
  hasMore,
  error,
  onSend,
  onStop,
  onRetry,
  onLoadMore,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const runnerModels = useRef<Record<string, string>>({});
  const [runnerOverride, setRunnerOverride] = useState<RunnerId | undefined>();
  const [availableRunners, setAvailableRunners] = useState<RunnerInstallationView[]>([]);
  const [runnerError, setRunnerError] = useState("");
  useEffect(() => {
    runnerModels.current = {};
    setRunnerOverride(undefined);
    setRunnerError("");
  }, [channel?.id, profile?.id]);
  const effectiveRunner = runnerOverride ?? profile?.runner ?? "native";
  const [mcpToolbarTarget, setMcpToolbarTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    let active = true;
    void client
      .runnerSetup()
      .then((setup) => {
        if (active) setAvailableRunners(setup.installations);
      })
      .catch((error) => {
        if (active)
          setRunnerError(error instanceof Error ? error.message : "Runner setup unavailable.");
      });
    return () => {
      active = false;
    };
  }, [client, profile?.id]);
  const [contextTarget, setContextTarget] = useState<HTMLDivElement | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextTab, setContextTab] = useState<string>("context");
  const toggleTab = (tab: "context" | "git") => {
    if (!contextOpen) {
      setContextOpen(true);
      setContextTab(tab);
      return;
    }
    if (contextTab !== tab) setContextTab(tab);
    else setContextOpen(false);
  };
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktop = window.matchMedia("(min-width: 1101px)");
    const updateContext = () => {
      if (!desktop.matches) setContextOpen(false);
    };
    desktop.addEventListener("change", updateContext);
    return () => desktop.removeEventListener("change", updateContext);
  }, []);
  const chunkedStreaming = useChunkedStreaming();
  const liveText = useStreamedText(live, chunkedStreaming);
  const liveLength = live?.tools.length ?? 0;

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: "auto" });
  }, [messages.length, liveText.length, liveLength, live?.phase]);

  if (!channel || !profile) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-400">
            No conversation selected
          </p>
          <h2 className="mt-3 text-2xl font-semibold">What would you like to work on?</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Choose New chat in the sidebar to start a conversation with your assistant.
          </p>
        </div>
      </div>
    );
  }

  const busy = live !== null && live.status === "running";

  return (
    <section className="chat-workspace">
      <header className="chat-header flex items-center gap-3 border-b px-6 py-3">
        <div className="chat-title min-w-0">
          <h1 className="truncate text-sm font-semibold text-slate-100">
            {channel.kind === "channel" ? <span className="mr-1 text-slate-500">#</span> : null}
            {channel.name}
          </h1>
          <p className="truncate text-[11px] text-slate-500">
            {channel.topic || (channel.kind === "dm" ? "Conversation" : "Channel conversation")}
          </p>
        </div>
        <div className="chat-profile ml-auto flex min-w-0 items-center gap-2 rounded-lg px-3 py-1 text-xs text-slate-400">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: `var(--profile-${profile.color})` }}
          />
          {profile.name}
        </div>
        <button
          type="button"
          className="header-control"
          onClick={() => onExecutionSettings?.("terminal", effectiveRunner)}
          aria-label="Terminal settings"
          title="Terminal settings"
        >
          <Icon name="terminal" />
          <span className="header-control-label">Terminal</span>
        </button>
        <ChoicePicker
          label="Runner for this message"
          className="runner-picker"
          prefix={<Icon name="terminal" />}
          value={runnerOverride ?? "profile"}
          options={[
            { value: "profile", label: `Profile runner · ${profile.runner ?? "native"}` },
            { value: "native", label: "Native · this message" },
            { value: "codex", label: "Codex · this message" },
            ...availableRunners
              .filter((entry) => entry.id.startsWith("acp:"))
              .map((entry) => ({
                value: entry.id,
                label: `${entry.name} · ${entry.enabled ? "enabled" : "disabled"}`,
              })),
          ]}
          onChange={(value) => {
            const nextRunner = value === "profile" ? (profile.runner ?? "native") : value;
            if (nextRunner !== effectiveRunner) {
              runnerModels.current[effectiveRunner] = profile.model;
              const model =
                runnerModels.current[nextRunner] ??
                (nextRunner !== "native" ? "agent-default" : profile.model);
              if (model !== profile.model) onModelChange?.(model);
            }
            setRunnerOverride(value === "profile" ? undefined : (value as RunnerId));
          }}
        />
        <div className="mcp-toolbar-target" ref={setMcpToolbarTarget} />
        <button
          type="button"
          className="header-control"
          onClick={() => onExecutionSettings?.("browser")}
          aria-label="Browser settings"
          title="Browser settings"
        >
          <Icon name="browser" />
          <span className="header-control-label">Browser</span>
        </button>
        <button
          type="button"
          className="header-control"
          aria-label="Show context"
          aria-controls="workspace-context"
          aria-expanded={contextOpen && contextTab === "context"}
          onClick={() => toggleTab("context")}
        >
          <Icon name="panel" />
          Context
        </button>
        <button
          type="button"
          className="header-control"
          aria-label="Show git changes"
          aria-controls="workspace-context"
          aria-expanded={contextOpen && contextTab === "git"}
          onClick={() => toggleTab("git")}
        >
          <Icon name="branch" />
          Git
        </button>
      </header>
      <div className="chat-layout">
        <div className="chat-main">
          <div ref={scrollRef} className="chat-scroll" role="log" aria-label="Conversation">
            {hasMore ? (
              <div className="mb-4 text-center">
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={loadingMore}
                  className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-400 hover:bg-white/5 disabled:opacity-40"
                >
                  {loadingMore ? "Loading…" : "Load earlier messages"}
                </button>
              </div>
            ) : null}

            {loading ? (
              <div className="space-y-3">
                <div className="h-16 w-2/3 animate-pulse rounded-2xl bg-white/5" />
                <div className="ml-auto h-12 w-1/2 animate-pulse rounded-2xl bg-white/5" />
              </div>
            ) : messages.length === 0 && !live ? (
              <div className="chat-welcome">
                <span className="chat-welcome-icon">
                  <Icon name="chat" />
                </span>
                <p className="chat-welcome-eyebrow">A little space to think</p>
                <h2>What would you like to work on?</h2>
                <p>Ask a question, explore an idea, or give {profile.name} a task.</p>
              </div>
            ) : (
              <div className="chat-column flex flex-col gap-6">
                {messages.map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    client={client}
                    onRetry={onRetry}
                    retryDisabled={busy || emergencyStopped}
                  />
                ))}

                {live ? (
                  <div className="flex justify-start">
                    <div className="message-assistant rounded-2xl px-4 py-3">
                      <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wide text-accent-300/80">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-400" />
                        <span role="status">
                          {live.status === "running"
                            ? live.phase === "thinking"
                              ? "Thinking…"
                              : live.phase === "tools"
                                ? "Using tools…"
                                : "Responding…"
                            : live.status}
                        </span>
                      </div>

                      <RunContent live={live} chunked={chunkedStreaming} />
                      {!liveText && !live.blocks.length && live.status === "running" ? (
                        <p className="py-2 text-xs text-slate-500">Preparing response…</p>
                      ) : null}

                      {live.usage ? (
                        <p className="mt-2 text-[10px] text-slate-500">
                          {live.usage.totalTokens} tokens
                          {live.usage.costUsd !== undefined
                            ? ` · $${live.usage.costUsd.toFixed(4)}`
                            : ""}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {error ? (
            <div className="chat-notice">
              <p
                role="alert"
                className="chat-column break-words rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-200"
              >
                {error}
              </p>
            </div>
          ) : null}

          <div className="chat-composer">
            {queuedMessages}
            <ContextComposer
              modelControls={
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <ModelPicker
                    key={`${channel.id}:${effectiveRunner}`}
                    client={client}
                    runner={effectiveRunner}
                    model={profile.model}
                    models={effectiveRunner === "native" ? models : []}
                    onChange={onModelChange}
                    reasoning={reasoning}
                    onReasoningChange={onReasoningChange}
                  />
                  {runnerError ? <span role="alert">{runnerError}</span> : null}
                </div>
              }
              mcpToolbarTarget={mcpToolbarTarget}
              contextTarget={contextTarget}
              activeRunCount={activeRunCount}
              key={channel.id}
              client={client}
              channel={channel}
              profile={{ ...profile, runner: effectiveRunner }}
              busy={busy}
              executionStopped={emergencyStopped}
              historyVersion={messages.length}
              lastRun={lastRun}
              runtimeContext={live?.runId === lastRun?.id ? live?.context : undefined}
              onSend={async (content, attachments, allowTruncation, mcpContextIds) => {
                await onSend(
                  content,
                  attachments,
                  allowTruncation,
                  runnerOverride,
                  undefined,
                  mcpContextIds,
                );
              }}
              onStop={onStop}
            />
          </div>
        </div>
        <aside
          id="workspace-context"
          className="workspace-context"
          aria-label="Workspace context"
          hidden={!contextOpen}
        >
          <WorkspaceTabs
            client={client}
            activeTab={contextTab}
            onSelect={setContextTab}
            onClose={() => setContextOpen(false)}
          >
            <RunTimeline
              key={channel.id}
              client={client}
              channelId={channel.id}
              version={messages.length}
              onRetry={onRetry}
            />
            <div ref={setContextTarget} />
          </WorkspaceTabs>
        </aside>
      </div>
    </section>
  );
}
