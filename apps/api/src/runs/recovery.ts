import {
  appendRunEvent,
  getMaxRunSeq,
  listRunningRuns,
  updateRun,
  type VektorDatabase,
  closeRunTools,
  appendAudit,
} from "@vektor/db";
import type { RunEvent } from "@vektor/shared";

const INTERRUPTED_ERROR = "Run interrupted by a server restart.";

export function recoverInterruptedRuns(db: VektorDatabase): string[] {
  const interrupted = listRunningRuns(db);
  const now = Date.now();

  for (const run of interrupted) {
    closeRunTools(db, run.id, INTERRUPTED_ERROR);
    appendAudit(db, "run.interrupted", run.id, { error: INTERRUPTED_ERROR });
    const seq = getMaxRunSeq(db, run.id) + 1;
    const event: RunEvent = {
      seq,
      runId: run.id,
      type: "run.failed",
      error: INTERRUPTED_ERROR,
      code: "interrupted",
    };

    appendRunEvent(db, {
      runId: run.id,
      seq,
      type: event.type,
      payloadJson: JSON.stringify(event),
    });

    updateRun(db, run.id, {
      status: "failed",
      error: INTERRUPTED_ERROR,
      endedAt: now,
    });
  }

  return interrupted.map((run) => run.id);
}
