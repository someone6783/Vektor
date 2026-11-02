import {
  appendRunEvent,
  getMaxRunSeq,
  listRunningRuns,
  updateRun,
  type VektorDatabase,
  closeRunTools,
  appendAudit,
  recoverAssistantMessage,
  listRunEvents,
} from "@vektor/db";
import { runEventSchema, type RunEvent } from "@vektor/shared";

const INTERRUPTED_ERROR = "Run interrupted by a server restart.";

export function recoverInterruptedRuns(db: VektorDatabase): string[] {
  const interrupted = listRunningRuns(db);
  const now = Date.now();

  for (const run of interrupted) {
    db.transaction((tx) => {
      const partial = listRunEvents(tx, run.id)
        .flatMap((record) => {
          try {
            const event = runEventSchema.parse(JSON.parse(record.payloadJson));
            return event.type === "message.delta" ? [event.text] : [];
          } catch {
            return [];
          }
        })
        .join("");
      recoverAssistantMessage(tx, run.id, run.channelId, partial);
      closeRunTools(tx, run.id, INTERRUPTED_ERROR);
      appendAudit(tx, "run.interrupted", run.id, { error: INTERRUPTED_ERROR });
      const seq = getMaxRunSeq(tx, run.id) + 1;
      const event: RunEvent = {
        seq,
        runId: run.id,
        type: "run.failed",
        error: INTERRUPTED_ERROR,
        code: "interrupted",
      };

      appendRunEvent(tx, {
        runId: run.id,
        seq,
        type: event.type,
        payloadJson: JSON.stringify(event),
      });

      updateRun(tx, run.id, {
        ...(run.harness && typeof run.harness === "object"
          ? { harness: { ...run.harness, state: "interrupted" } }
          : {}),
        status: "failed",
        error: INTERRUPTED_ERROR,
        endedAt: now,
      });
    });
  }

  return interrupted.map((run) => run.id);
}
