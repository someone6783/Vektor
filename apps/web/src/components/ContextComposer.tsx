import { useEffect, useRef, useState } from "react";
import type { Attachment, Channel, ContextEstimate, Profile, Run } from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { AttachmentPreview } from "./Attachments";

interface Props {
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
  const operation = useRef(false);
  const mounted = useRef(true);

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
      className={`mx-auto max-w-3xl rounded-2xl border p-3 ${dragging ? "border-emerald-300 bg-emerald-400/10" : "border-white/10 bg-slate-900/70"}`}
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <button
          type="button"
          disabled={working || !loaded || sending}
          onClick={() => input.current?.click()}
          className="rounded-lg border border-white/20 px-3 py-1.5 text-slate-200 disabled:opacity-40"
        >
          {working ? "Processing files…" : "Attach files"}
        </button>
        <span className="text-slate-400">
          {files.filter((file) => file.included).length} included ·{" "}
          {(files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)} /{" "}
          {(limits.channelFileBytes / 1024 / 1024).toFixed(0)} MB
        </span>
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
      </div>
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
      <p className="mb-2 text-[10px] text-slate-500">
        Paste images or drop files here · UTF-8 text, code, PDF, DOCX, PNG, JPEG, WebP, GIF
      </p>
      {estimate ? (
        <div className="mb-3 text-xs text-slate-400" aria-live="polite">
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
            className="mt-1 h-2 w-full"
          />
          <details>
            <summary className="cursor-pointer text-[10px]">
              Estimate details · {estimate.selectedAttachments} files ·{" "}
              {estimate.attachmentTokens.toLocaleString()} file tokens
            </summary>
            {estimate.warnings.map((warning) => (
              <p key={warning} className="mt-1 text-[10px]">
                {warning}
              </p>
            ))}
          </details>
          {estimate.exceedsBudget ? (
            <p role="alert" className="mt-2 text-rose-300">
              Context is too large. Exclude files, shorten the message, lower max output tokens, or
              choose a larger model.
            </p>
          ) : null}
          {estimate.requiresTruncation && !estimate.exceedsBudget ? (
            <label className="mt-2 flex gap-2 text-amber-200">
              <input
                type="checkbox"
                checked={allowTruncation}
                onChange={(event) => setAllowTruncation(event.target.checked)}
              />
              Omit {estimate.droppedMessages} oldest messages for this run
            </label>
          ) : null}
        </div>
      ) : (
        <p className="mb-3 text-xs text-slate-500">
          {loaded ? "Estimating context…" : "Loading attachments…"}
        </p>
      )}
      {lastRun?.context ? (
        <p className="mb-3 text-[10px] text-slate-400">
          Last run: {lastRun.context.inputTokens.toLocaleString()} estimated input tokens
          {lastRun.usage
            ? ` · Actual usage: ${lastRun.usage.promptTokens.toLocaleString()} input + ${lastRun.usage.completionTokens.toLocaleString()} output${lastRun.usage.costUsd !== undefined ? ` · $${lastRun.usage.costUsd.toFixed(4)}` : ""}`
            : " · Provider usage unavailable"}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mb-2 text-xs text-rose-300">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-slate-500">Enter sends · Shift+Enter adds a line</span>
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
      {preview ? (
        <AttachmentPreview file={preview} client={client} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}
