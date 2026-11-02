import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { OverflowMenu } from "./OverflowMenu";
import { createPortal } from "react-dom";
import type {
  Attachment,
  Channel,
  ContextEstimate,
  Profile,
  Run,
  McpContext,
} from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { AttachmentPreview } from "./Attachments";

interface Props {
  modelControls?: ReactNode;
  contextTarget?: HTMLElement | null;
  activeRunCount?: number;
  executionStopped?: boolean;
  client: ApiClient;
  channel: Channel;
  profile: Profile;
  busy: boolean;
  historyVersion: number;
  lastRun: Run | null;
  onSend: (
    content: string,
    attachmentIds: string[],
    allowTruncation: boolean,
    mcpContextIds?: string[],
  ) => Promise<void>;
  onStop: () => void;
  onRetry: () => void;
  canRetry: boolean;
}

export function ContextComposer({
  modelControls,
  contextTarget = null,
  activeRunCount = 0,
  executionStopped = false,
  client,
  channel,
  profile,
  busy,
  historyVersion,
  lastRun,
  onSend,
  onStop,
  onRetry,
  canRetry,
}: Props) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [mcpContexts, setMcpContexts] = useState<McpContext[]>([]),
    [mcpSelected, setMcpSelected] = useState<string[]>([]),
    [mcpPreview, setMcpPreview] = useState<string | null>(null);
  useEffect(() => {
    setMcpContexts([]);
    setMcpSelected([]);
    setMcpPreview(null);
  }, [channel.id, profile.id]);
  const [limits, setLimits] = useState({
    maxFileBytes: 25 * 1024 * 1024,
    channelFileBytes: 250 * 1024 * 1024,
    maxFiles: 50,
  });
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<ContextEstimate | null>(null);
  const [allowTruncation, setAllowTruncation] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef(false);
  const mounted = useRef(true);

  const includedFiles = files.filter((file) => file.included).length;
  const contextPercent = estimate
    ? Math.ceil(
        ((estimate.inputTokens + estimate.reservedOutputTokens) / estimate.contextWindow) * 100,
      )
    : null;

  useEffect(() => {
    mounted.current = true;
    void client
      .listAttachments(channel.id)
      .then((result) => {
        if (mounted.current) {
          setFiles(result.attachments);
          setLimits(result.limits);
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (mounted.current) setError(error.message);
      });
    return () => {
      mounted.current = false;
    };
  }, [client, channel.id]);

  useEffect(() => {
    let active = true;
    setAllowTruncation(false);
    if (!loaded) return;
    const timer = setTimeout(() => {
      void client
        .estimateContext(channel.id, {
          content: draft.trim(),
          profileId: profile.id,
          runner: profile.runner,
          model: profile.model,
          attachmentIds: files.filter((file) => file.included).map((file) => file.id),
          mcpContextIds: mcpSelected,
        })
        .then((result) => {
          if (active) {
            setEstimate(result);
          }
        })
        .catch((error) => {
          if (active) setError(error.message);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, channel.id, draft, files, profile, historyVersion, loaded, mcpSelected]);

  const upload = async (uploads: File[]) => {
    if (!uploads.length || operation.current || !loaded) return;
    operation.current = true;
    setWorking(true);
    setError(null);
    try {
      for (const file of uploads) {
        if (file.size > limits.maxFileBytes)
          throw new Error(
            `${file.name} exceeds the ${(limits.maxFileBytes / 1024 / 1024).toFixed(0)} MB upload limit.`,
          );
        const saved = await client.uploadAttachment(channel.id, file);
        if (mounted.current) setFiles((value) => [...value, saved]);
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      operation.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  const changeFile = async (file: Attachment, remove = false) => {
    if (operation.current) return;
    operation.current = true;
    setWorking(true);
    setError(null);
    try {
      if (remove) {
        await client.deleteAttachment(file.id);
        if (mounted.current) setFiles((value) => value.filter((item) => item.id !== file.id));
      } else {
        const updated = await client.updateAttachment(file.id, !file.included);
        if (mounted.current)
          setFiles((value) => value.map((item) => (item.id === updated.id ? updated : item)));
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "File update failed.");
    } finally {
      operation.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  const canSend = !!draft.trim() || files.some((file) => file.included) || mcpSelected.length > 0;
  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend(
        draft.trim(),
        files.filter((file) => file.included).map((file) => file.id),
        allowTruncation,
        ...(mcpSelected.length ? ([mcpSelected] as [string[]]) : ([] as [])),
      );
      if (mounted.current) {
        setDraft("");
        setMcpSelected([]);
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "Send failed.");
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  const attachmentList = files.length ? (
    <ul aria-label="Channel attachments" className="mb-3 max-h-44 space-y-2 overflow-y-auto">
      {files.map((file) => (
        <li
          key={file.id}
          className="flex items-center gap-2 rounded-lg bg-white/5 px-2 py-1.5 text-xs"
        >
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <input
              type="checkbox"
              checked={file.included}
              disabled={working || sending}
              onChange={() => void changeFile(file)}
              aria-label={`Include ${file.filename} in context`}
            />
            <span className="truncate">{file.filename}</span>
            <span className="shrink-0 text-slate-500">{Math.ceil(file.size / 1024)} KB</span>
          </label>
          <OverflowMenu label={`Actions for ${file.filename}`}>
            <button
              type="button"
              onClick={() => setPreview(file)}
              className="text-accent-300"
              aria-label={`Preview ${file.filename}`}
            >
              <Icon name="file" /> Preview
            </button>
            <button
              type="button"
              disabled={busy || working || sending}
              onClick={() => void changeFile(file, true)}
              className="text-slate-400 disabled:opacity-30"
              aria-label={`Remove ${file.filename}`}
            >
              <Icon name="trash" /> Remove
            </button>
          </OverflowMenu>
        </li>
      ))}
    </ul>
  ) : null;

  return (
    <div
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void upload(Array.from(event.dataTransfer.files));
      }}
      className="context-composer"
    >
      <div
        aria-label="Message composer"
        className={`message-composer border p-3 ${dragging ? "border-accent-300 bg-accent-400/10" : "border-white/10 bg-slate-900/70"}`}
      >
        <input
          ref={input}
          type="file"
          multiple
          aria-label="Upload attachments"
          className="hidden"
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        {!contextTarget ? attachmentList : null}
        <textarea
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.items)
              .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
              .map((item) => item.getAsFile())
              .filter((file): file is File => file !== null);
            if (images.length) {
              event.preventDefault();
              void upload(images);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder={`Message ${channel.kind === "dm" ? "@" : "#"}${channel.name}`}
          className="w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600"
        />
        <details className="my-2 text-xs text-slate-400">
          <summary className="cursor-pointer">MCP context · {mcpSelected.length} selected</summary>
          <p className="my-2">
            Prepare and preview resources or prompts in Settings → MCP plugins, then explicitly
            select them for this message.
          </p>
          <button
            type="button"
            className="rounded border border-white/10 px-2 py-1"
            onClick={() => {
              void client
                .mcpContexts(profile.id)
                .then(setMcpContexts)
                .catch((cause) => setError(cause.message));
            }}
          >
            Load prepared MCP context
          </button>
          {mcpContexts.map((item) => (
            <div key={item.id} className="my-2 flex flex-wrap items-center gap-2">
              <label>
                <input
                  type="checkbox"
                  checked={mcpSelected.includes(item.id)}
                  disabled={!mcpSelected.includes(item.id) && mcpSelected.length >= 5}
                  onChange={(e) =>
                    setMcpSelected(
                      e.target.checked
                        ? [...mcpSelected, item.id]
                        : mcpSelected.filter((id) => id !== item.id),
                    )
                  }
                />{" "}
                {item.kind}: {item.name} · {Math.ceil(item.size / 1024)} KB
              </label>
              <button
                type="button"
                onClick={() => {
                  void client
                    .mcpContext(item.id)
                    .then((r) => setMcpPreview(r.text))
                    .catch((cause) => setError(cause.message));
                }}
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => {
                  void client
                    .removeMcpContext(item.id)
                    .then(() => {
                      setMcpSelected((v) => v.filter((id) => id !== item.id));
                      setMcpContexts((v) => v.filter((c) => c.id !== item.id));
                    })
                    .catch((cause) => setError(cause.message));
                }}
              >
                Delete
              </button>
            </div>
          ))}
          {mcpPreview !== null ? (
            <div>
              <pre className="my-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">
                {mcpPreview}
              </pre>
              <button type="button" onClick={() => setMcpPreview(null)}>
                Close MCP preview
              </button>
            </div>
          ) : null}
        </details>
        {estimate?.exceedsBudget ? (
          <p role="alert" className="mt-2 text-rose-300">
            Context is too large. Exclude files, shorten the message, lower max output tokens, or
            choose a larger model.
          </p>
        ) : null}
        {estimate?.requiresTruncation && !estimate.exceedsBudget ? (
          <label className="mt-2 flex gap-2 text-amber-200">
            <input
              type="checkbox"
              checked={allowTruncation}
              onChange={(event) => setAllowTruncation(event.target.checked)}
            />
            Omit {estimate.droppedMessages} oldest messages for this run
          </label>
        ) : null}
        {executionStopped ? (
          <p className="mb-2 text-xs text-rose-300">
            Execution is stopped. Messages will wait in the queue until you resume.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mb-2 text-xs text-rose-300">
            {error}
          </p>
        ) : null}
        <div className="composer-toolbar flex items-center gap-2">
          <button
            type="button"
            aria-label={working ? "Processing files" : "Attach files"}
            title="Attach files · You can also paste images or drop files"
            disabled={working || !loaded || sending}
            onClick={() => input.current?.click()}
            className="attach-button grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-slate-100 focus-visible:outline focus-visible:outline-accent-400 disabled:opacity-40"
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <div className="ml-auto flex gap-2">
            {busy ? (
              <button
                type="button"
                onClick={onStop}
                className="rounded-lg border border-rose-400/30 px-3 py-1.5 text-xs text-rose-200"
              >
                Stop
              </button>
            ) : canRetry ? (
              <OverflowMenu label="Message actions">
                <button type="button" disabled={executionStopped} onClick={onRetry}>
                  <Icon name="refresh" /> Regenerate
                </button>
              </OverflowMenu>
            ) : null}
            {modelControls}
            <button
              type="button"
              disabled={!canSend}
              title={busy ? "Queue this message until the current run finishes" : "Send message"}
              onClick={() => void submit()}
              className="rounded-lg bg-accent-400 px-4 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
            >
              {busy ? "Queue" : "Send"}
              <Icon name="arrow" />
            </button>
          </div>
        </div>
      </div>
      <footer
        aria-label="Conversation status"
        className="composer-status relative flex items-center text-slate-400"
      >
        <span
          aria-label="Context usage"
          className={`flex items-center gap-1.5 rounded px-[5px] py-1 ${estimate?.exceedsBudget ? "text-rose-300" : estimate?.requiresTruncation ? "text-amber-200" : ""}`}
        >
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" className="-rotate-90">
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeOpacity=".2"
              strokeWidth="2"
            />
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              pathLength="100"
              strokeDasharray={`${Math.min(contextPercent ?? 0, 100)} 100`}
            />
          </svg>
          Context {contextPercent === null ? "…" : `${contextPercent}%`}
        </span>
        <span
          title="Active runs across all channels"
          className="flex items-center gap-1.5 whitespace-nowrap"
        >
          <span
            aria-hidden="true"
            className={`h-1 w-1 rounded-full ${activeRunCount ? "animate-pulse bg-accent-400" : "bg-slate-600"}`}
          />
          {activeRunCount} active {activeRunCount === 1 ? "run" : "runs"}
        </span>
        <span
          title={`${includedFiles} included · ${(files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)} / ${(limits.channelFileBytes / 1024 / 1024).toFixed(0)} MB stored`}
          className="whitespace-nowrap"
        >
          {includedFiles} {includedFiles === 1 ? "file" : "files"}
        </span>
        <span className="ml-auto hidden sm:inline">Enter sends · Shift+Enter adds a line</span>
      </footer>
      {contextTarget
        ? createPortal(
            <>
              <section className="context-section">
                <h3>Included context</h3>
                {files.length ? (
                  attachmentList
                ) : (
                  <p>{loaded ? "No files attached." : "Loading attachments…"}</p>
                )}
              </section>
              <section className="context-section">
                <h3>Context budget</h3>
                <p>Estimated next request</p>
                {estimate ? (
                  <>
                    <meter
                      aria-label="Inspector context budget"
                      min={0}
                      max={estimate.contextWindow}
                      value={Math.min(
                        estimate.contextWindow,
                        estimate.inputTokens + estimate.reservedOutputTokens,
                      )}
                    />
                    <p>
                      {(estimate.inputTokens + estimate.reservedOutputTokens).toLocaleString()} /{" "}
                      {estimate.contextWindow.toLocaleString()} tokens
                    </p>
                    <p>
                      {estimate.inputTokens.toLocaleString()} input +{" "}
                      {estimate.reservedOutputTokens.toLocaleString()} reserved output
                    </p>
                    {estimate.warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </>
                ) : (
                  <p>Estimating context…</p>
                )}
              </section>
              {lastRun?.usage ? (
                <section className="context-section">
                  <h3>Last run usage</h3>
                  <p>
                    Total across{" "}
                    {lastRun.usage.rounds !== undefined
                      ? `${lastRun.usage.rounds} model ${lastRun.usage.rounds === 1 ? "call" : "calls"}`
                      : "model calls"}
                  </p>
                  <p>
                    {lastRun.usage.promptTokens.toLocaleString()} input +{" "}
                    {lastRun.usage.completionTokens.toLocaleString()} output tokens
                  </p>
                  <p>Input can be counted again after each tool call.</p>
                </section>
              ) : null}
            </>,
            contextTarget,
          )
        : null}
      {preview ? (
        <AttachmentPreview file={preview} client={client} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}
