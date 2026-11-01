import { useEffect, useRef, useState } from "react";
import type { Channel, Message, Profile, Run } from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { ContextComposer } from "./ContextComposer";
import { MessageAttachments } from "./Attachments";
import { RunTimeline } from "./RunTimeline";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import type { LiveRun } from "../lib/live";

interface ChatViewProps {
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
  onSend: (content: string, attachmentIds: string[], allowTruncation: boolean) => Promise<void>;
  onStop: () => void;
  onRetry: (runId: string) => void;
  onLoadMore: () => void;
}

const statusLabel: Record<string, string> = {
  cancelled: "stopped",
  failed: "failed",
};

function MessageRow({ message, client }: { message: Message; client: ApiClient }) {
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
            {message.content ? (
              <Markdown>{message.content}</Markdown>
            ) : (
              <p className="text-sm italic text-slate-500">No output.</p>
            )}
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
      </div>
    </div>
  );
}

export function ChatView({
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
  const [contextTarget, setContextTarget] = useState<HTMLDivElement | null>(null);
  const [contextOpen, setContextOpen] = useState(
    () =>
      typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1101px)").matches,
  );
  const liveText = live?.text ?? "";
  const liveLength = live?.tools.length ?? 0;

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: "auto" });
  }, [messages.length, liveText.length, liveLength]);

  if (!channel || !profile) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-400">
            No conversation selected
          </p>
          <h2 className="mt-3 text-2xl font-semibold">Create a channel to start.</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Pick a profile, then create a channel or a direct conversation in the sidebar.
          </p>
        </div>
      </div>
    );
  }

  const busy = live !== null && live.status === "running";

  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");

  return (
    <section className="chat-workspace">
      <header className="chat-header flex items-center gap-3 border-b px-6 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-slate-100">
            <span className="mr-1 text-slate-500">{channel.kind === "dm" ? "@" : "#"}</span>
            {channel.name}
          </h1>
          <p className="truncate text-[11px] text-slate-500">
            {channel.topic || (channel.kind === "dm" ? "Direct conversation" : "Channel")}
          </p>
        </div>
        <div className="chat-profile ml-auto flex min-w-0 items-center gap-2 rounded-lg px-3 py-1 text-xs text-slate-400">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: `var(--profile-${profile.color})` }}
          />
          {profile.name}
          <span className="text-slate-500">· {profile.terminalMode}</span>
          <span className="text-slate-600">·</span>
          <span className="truncate font-mono text-[11px]" title={profile.model}>
            {profile.model}
          </span>
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-300 hover:bg-white/5"
          aria-label={contextOpen ? "Hide context" : "Show context"}
          aria-controls="workspace-context"
          aria-expanded={contextOpen}
          onClick={() => setContextOpen((open) => !open)}
        >
          <Icon name="panel" />
          Context
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
              <div className="mx-auto mt-16 max-w-md text-center">
                <p className="text-sm font-medium text-slate-300">Start the conversation.</p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  Messages stream from the provider and are persisted as ordered run events. Reload
                  mid-stream and the same run replays.
                </p>
              </div>
            ) : (
              <div className="chat-column flex flex-col gap-6">
                {messages.map((message) => (
                  <MessageRow key={message.id} message={message} client={client} />
                ))}

                {live ? (
                  <div className="flex justify-start">
                    <div className="message-assistant rounded-2xl px-4 py-3">
                      <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wide text-accent-300/80">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-400" />
                        {live.status === "running" ? "Streaming" : live.status}
                        <span className="text-slate-600">seq {live.lastSeq}</span>
                      </div>

                      {live.text ? (
                        <Markdown>{live.text}</Markdown>
                      ) : (
                        <div className="flex gap-1 py-2">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-400/60" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-400/40 [animation-delay:100ms]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-400/20 [animation-delay:200ms]" />
                        </div>
                      )}

                      {live.tools.length > 0 ? (
                        <ul className="mt-3 space-y-1">
                          {live.tools.map((tool) => (
                            <li
                              key={tool.id}
                              className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 font-mono text-[10px] text-amber-200/80"
                            >
                              tool: {tool.name}
                            </li>
                          ))}
                        </ul>
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
            <p className="mx-6 mb-2 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-200">
              {error}
            </p>
          ) : null}

          <div className="chat-composer">
            <ContextComposer
              contextTarget={contextTarget}
              activeRunCount={activeRunCount}
              key={channel.id}
              client={client}
              channel={channel}
              profile={profile}
              busy={busy}
              executionStopped={emergencyStopped}
              historyVersion={messages.length}
              lastRun={lastRun}
              onSend={onSend}
              onStop={onStop}
              canRetry={!!lastAssistant?.runId}
              onRetry={() => {
                if (lastAssistant?.runId) onRetry(lastAssistant.runId);
              }}
            />
          </div>
        </div>
        <aside
          id="workspace-context"
          className="workspace-context"
          aria-label="Workspace context"
          hidden={!contextOpen}
        >
          <div className="context-heading">
            <h2>Workspace context</h2>
            <button type="button" aria-label="Close context" onClick={() => setContextOpen(false)}>
              <Icon name="close" />
            </button>
          </div>
          <RunTimeline
            key={channel.id}
            client={client}
            channelId={channel.id}
            version={messages.length}
            onRetry={onRetry}
          />
          <div ref={setContextTarget} />
        </aside>
      </div>
    </section>
  );
}
