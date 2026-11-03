import { useState } from "react";
import { Icon } from "./Icon";
import type { Channel } from "@vektor/shared";
import type { QueuedMessage, useMessageQueue } from "../lib/useMessageQueue";

function permissionIssue(item: QueuedMessage) {
  return (
    item.errorCode === "runner_permissions" ||
    item.errorCode === "runner_grants" ||
    /External runners currently require Full access|Grant this profile workspace and inference access/.test(
      item.error ?? "",
    )
  );
}
function QueueItem({
  item,
  queue,
  channel,
  paused,
  onReviewPermissions,
}: {
  onReviewPermissions?: (item: QueuedMessage) => void;
  item: QueuedMessage;
  queue: ReturnType<typeof useMessageQueue>;
  channel: string;
  paused: boolean;
}) {
  const [allowTruncation, setAllowTruncation] = useState(item.allowTruncation);
  const status = item.error
    ? "Needs attention"
    : item.steer
      ? "Steering…"
      : queue.sendingId === item.id
        ? "Sending…"
        : paused
          ? "Paused"
          : "Queued";
  const needsPermissions = permissionIssue(item);
  const preview = item.content || `${item.attachmentIds.length} attachments`;
  return (
    <li className="queue-item">
      <div className="queue-row">
        <span className="queue-indicator" title={`${channel} · ${status}`}>
          <Icon name="clock" />
          <span className="sr-only">
            {channel} · {status}
          </span>
        </span>
        <p className="queue-preview" title={preview}>
          {preview}
        </p>
        {status !== "Queued" ? <span className="queue-status">{status}</span> : null}
        <div className="queue-actions">
          <button
            type="button"
            disabled={paused || queue.sendingId !== null || !!item.steer}
            onClick={() => queue.steer(item.id)}
            title="Stop the current run and send this message next"
            className="queue-steer"
          >
            <Icon name="arrow" /> Steer
          </button>
          <button
            type="button"
            disabled={queue.sendingId === item.id}
            onClick={() => queue.remove(item.id)}
            aria-label="Remove queued message"
            title="Remove queued message"
            className="queue-remove"
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
      {item.error ? (
        <div className="queue-error">
          <p role="alert" className="text-rose-300">
            {needsPermissions
              ? "This agent needs approved tool access. Review permissions to continue."
              : item.error}
          </p>
          {needsPermissions && onReviewPermissions ? (
            <button type="button" onClick={() => onReviewPermissions(item)}>
              Review permissions
            </button>
          ) : null}
          {!needsPermissions ? (
            <label className="my-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={allowTruncation}
                onChange={(event) => setAllowTruncation(event.target.checked)}
              />
              Allow omitting older history if needed
            </label>
          ) : null}
          <button type="button" onClick={() => queue.retry(item.id, allowTruncation)}>
            Retry
          </button>
        </div>
      ) : null}
    </li>
  );
}
export function MessageQueue({
  queue,
  channels,
  paused,
  onReviewPermissions,
}: {
  onReviewPermissions?: (item: QueuedMessage) => void;
  queue: ReturnType<typeof useMessageQueue>;
  channels: Channel[];
  paused: boolean;
}) {
  if (!queue.items.length) return null;
  return (
    <section aria-label="Queued messages" className="message-queue chat-column">
      <p className="sr-only">
        {queue.items.length} queued {paused ? "· Paused" : "· Sends when ready"}
      </p>
      <ol className="queue-list">
        {queue.items.map((item) => (
          <QueueItem
            key={item.id}
            item={item}
            queue={queue}
            paused={paused}
            onReviewPermissions={onReviewPermissions}
            channel={
              channels.find((channel) => channel.id === item.channelId)?.name ?? "Conversation"
            }
          />
        ))}
      </ol>
    </section>
  );
}
