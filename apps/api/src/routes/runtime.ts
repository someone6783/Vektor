import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { compactTranscript } from "../runs/transcript.js";
import {
  getRun,
  listApprovals,
  listAudit,
  listRunEvents,
  listRunningRuns,
  listRuns,
  listToolCalls,
  type VektorDatabase,
} from "@vektor/db";
import { approvalSchema, auditEntrySchema, runEventSchema, toolCallSchema } from "@vektor/shared";
import type { RunManager } from "../runs/run-manager.js";
import { RuntimeError, type TerminalExecutor } from "../runtime/terminal.js";
import { toRun } from "../serializers.js";

export function approvalView(record: ReturnType<typeof listApprovals>[number]) {
  return approvalSchema.parse({
    ...record,
    createdAt: record.createdAt.toISOString(),
    resolvedAt: record.resolvedAt?.toISOString() ?? null,
  });
}
export function registerRuntimeRoutes(
  app: FastifyInstance,
  db: VektorDatabase,
  manager: RunManager,
  terminal: TerminalExecutor,
  executionEnvironment: "host" | "container",
): void {
  app.get("/api/runtime", async () => ({
    emergencyStopped: manager.stopped,
    terminalSupported: terminal.supported,
    executionEnvironment,
    activeRuns: listRunningRuns(db).map(toRun),
    approvals: listApprovals(db).map(approvalView),
  }));
  app.post("/api/runtime/emergency-stop", async () => {
    await manager.emergencyStop();
    return { emergencyStopped: true };
  });
  app.post("/api/runtime/resume", async () => {
    manager.resume();
    return { emergencyStopped: false };
  });
  app.post("/api/approvals/:approvalId", async (request) => {
    const { approvalId } = request.params as { approvalId: string };
    const { approved } = z.object({ approved: z.boolean() }).strict().parse(request.body);
    await manager.decideApproval(approvalId, approved);
    return { resolved: true };
  });
  app.get("/api/runs", async (request) => {
    const query = z
      .object({ channelId: z.string().optional(), before: z.coerce.number().positive().optional() })
      .parse(request.query);
    const runs = listRuns(db, query.channelId, query.before);
    return {
      runs: runs.map(toRun),
      nextBefore: runs.length === 30 ? runs.at(-1)!.startedAt : null,
    };
  });
  app.get("/api/runs/:runId/details", async (request) => {
    const query = z.object({ transcript: z.literal("1").optional() }).parse(request.query);
    const { runId } = request.params as { runId: string };
    const run = getRun(db, runId);
    if (!run) throw new RuntimeError("Run not found.", 404);
    const events = listRunEvents(db, runId);
    return {
      ...(query.transcript ? { transcript: compactTranscript(events) } : {}),
      browser: manager.browserState(runId),
      computer: manager.computerState(runId),
      run: toRun(run),
      tools: listToolCalls(db, runId).map((tool) =>
        toolCallSchema.parse({
          ...tool,
          input: JSON.parse(tool.inputJson),
          createdAt: tool.createdAt.toISOString(),
          endedAt: tool.endedAt?.toISOString() ?? null,
        }),
      ),
      approvals: listApprovals(db, runId).map(approvalView),
      events: events
        .filter((event) => event.type !== "message.delta" && event.type !== "reasoning.delta")
        .slice(-200)
        .map((event) => runEventSchema.parse(JSON.parse(event.payloadJson))),
    };
  });
  app.get("/api/audit", async (request) => {
    const query = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    const records = listAudit(db, query.before);
    return {
      entries: records.map((record) =>
        auditEntrySchema.parse({
          ...record,
          details: JSON.parse(record.detailsJson),
          createdAt: record.createdAt.toISOString(),
        }),
      ),
      nextBefore: records.length === 50 ? records.at(-1)!.id : null,
    };
  });
}
