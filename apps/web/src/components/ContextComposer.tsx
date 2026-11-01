import { useEffect, useRef, useState } from "react";
import type { Attachment, Channel, ContextEstimate, Profile, Run } from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { AttachmentPreview } from "./Attachments";

interface Props {
  activeRunCount?: number;
  executionStopped?: boolean;
  client: ApiClient;
  channel: Channel;
  profile: Profile;
  busy: boolean;
  historyVersion: number;
  lastRun: Run | null;
  onSend: (content: string, attachmentIds: string[], allowTruncation: boolean) => Promise<void>;
  onStop: () => void;
  onRetry: () => void;
  canRetry: boolean;
}

export function ContextComposer({
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
  const contextMenu = useRef<HTMLDetailsElement>(null);
  const operation = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (contextMenu.current && !contextMenu.current.contains(event.target as Node))
        contextMenu.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

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
    setEstimate(null);
    setAllowTruncation(false);
    if (!loaded) return;
    const timer = setTimeout(() => {
      void client
        .estimateContext(channel.id, {
          content: draft.trim(),
          profileId: profile.id,
          attachmentIds: files.filter((file) => file.included).map((file) => file.id),
        })
        .then((result) => {
          if (active) setEstimate(result);
        })
        .catch((error) => {
          if (active) setError(error.message);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, channel.id, draft, files, profile, historyVersion, loaded]);

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

  const canSend =
    !executionStopped &&
    !busy &&
    !sending &&
    !working &&
    (!!draft.trim() || files.some((file) => file.included)) &&
    !!estimate &&
    !estimate.exceedsBudget &&
    (!estimate.requiresTruncation || allowTruncation);
  const submit = async () => {
    if (!canSend || operation.current) return;
    operation.current = true;
    setSending(true);
    setError(null);
    try {
      await onSend(
        draft.trim(),
        files.filter((file) => file.included).map((file) => file.id),
        allowTruncation,
      );
      if (mounted.current) setDraft("");
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "Send failed.");
    } finally {
      operation.current = false;
      if (mounted.current) setSending(false);
    }
  };

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
      className="mx-auto max-w-3xl"
    >
      <div
        aria-label="Message composer"
        className={`rounded-2xl border p-3 ${dragging ? "border-emerald-300 bg-emerald-400/10" : "border-white/10 bg-slate-900/70"}`}
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
        {files.length ? (
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
                <button
                  type="button"
                  onClick={() => setPreview(file)}
                  className="text-emerald-300"
                  aria-label={`Preview ${file.filename}`}
                >
                  Preview
                </button>
                <button
                  type="button"
                  disabled={busy || working || sending}
                  onClick={() => void changeFile(file, true)}
                  className="text-slate-400 disabled:opacity-30"
                  aria-label={`Remove ${file.filename}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
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
          rows={3}
          placeholder={`Message ${channel.kind === "dm" ? "@" : "#"}${channel.name}`}
          className="w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600"
        />
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
            Execution is stopped. Resume from the runtime controls to send a message.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mb-2 text-xs text-rose-300">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={working ? "Processing files" : "Attach files"}
            title="Attach files · You can also paste images or drop files"
            disabled={working || !loaded || sending}
            onClick={() => input.current?.click()}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-slate-100 focus-visible:outline focus-visible:outline-emerald-400 disabled:opacity-40"
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
              <button
                type="button"
                disabled={executionStopped}
                onClick={onRetry}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs"
              >
                Regenerate
              </button>
            ) : null}
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void submit()}
              className="rounded-lg bg-emerald-400 px-4 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
      <footer
        aria-label="Conversation status"
        className="relative flex min-h-8 items-center gap-4 px-1 text-[10px] text-slate-500"
      >
        <details
          ref={contextMenu}
          className="group"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            aria-label="Context usage"
            className={`flex cursor-pointer list-none items-center gap-1.5 rounded py-1 outline-none hover:text-slate-200 focus-visible:ring-1 focus-visible:ring-emerald-400 [&::-webkit-details-marker]:hidden ${estimate?.exceedsBudget ? "text-rose-300" : estimate?.requiresTruncation ? "text-amber-200" : ""}`}
          >
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 16 16"
              className="-rotate-90"
            >
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
            <svg
              aria-hidden="true"
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="m4 10 4-4 4 4" />
            </svg>
          </summary>
          <div className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-80 max-w-[calc(100vw-3rem)] overflow-y-auto rounded-xl border border-white/10 bg-slate-900 p-4 text-xs text-slate-400 shadow-xl">
            <h2 className="mb-3 font-medium text-slate-100">Context usage</h2>
            {estimate ? (
              <>
                <p>
                  Estimated input: {estimate.inputTokens.toLocaleString()} tokens +{" "}
                  {estimate.reservedOutputTokens.toLocaleString()} output /{" "}
                  {estimate.contextWindow.toLocaleString()} context
                </p>
                <meter
                  aria-label="Context budget"
                  min={0}
                  max={estimate.contextWindow}
                  value={Math.min(
                    estimate.contextWindow,
                    estimate.inputTokens + estimate.reservedOutputTokens,
                  )}
                  className="my-3 h-1 w-full"
                />
                <p>
                  {estimate.selectedAttachments} files ·{" "}
                  {estimate.attachmentTokens.toLocaleString()} file tokens
                </p>
                {estimate.warnings.map((warning) => (
                  <p key={warning} className="mt-2 text-[11px]">
                    {warning}
                  </p>
                ))}
              </>
            ) : (
              <p>{loaded ? "Estimating context…" : "Loading attachments…"}</p>
            )}
            {lastRun?.context ? (
              <p className="mt-3 border-t border-white/10 pt-3 text-[11px]">
                Last run: {lastRun.context.inputTokens.toLocaleString()} estimated input tokens
                {lastRun.usage
                  ? ` · Actual usage: ${lastRun.usage.promptTokens.toLocaleString()} input + ${lastRun.usage.completionTokens.toLocaleString()} output${lastRun.usage.costUsd !== undefined ? ` · $${lastRun.usage.costUsd.toFixed(4)}` : ""}`
                  : " · Provider usage unavailable"}
              </p>
            ) : null}
          </div>
        </details>
        <span
          title="Active runs across all channels"
          className="flex items-center gap-1.5 whitespace-nowrap"
        >
          <span
            aria-hidden="true"
            className={`h-1 w-1 rounded-full ${activeRunCount ? "animate-pulse bg-emerald-400" : "bg-slate-600"}`}
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
      {preview ? (
        <AttachmentPreview file={preview} client={client} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}
