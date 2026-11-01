import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { usageRows, type VektorDatabase } from "@vektor/db";
import {
  runUsageSchema,
  usageReportSchema,
  type UsageReport,
  type UsageSummary,
} from "@vektor/shared";
import { RuntimeError } from "../runtime/terminal.js";

function empty(): UsageSummary {
  return {
    runs: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    runsWithUsage: 0,
    runsWithoutUsage: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    providerCalls: 0,
    reportedCalls: 0,
    pricedCalls: 0,
    incompleteCostRuns: 0,
    knownCostUsd: null,
  };
}
export function usageReport(
  db: VektorDatabase,
  from: Date,
  to: Date,
  provider: UsageReport["provider"],
): UsageReport {
  const totals = empty();
  const byProfile = new Map<string, UsageReport["byProfile"][number]>();
  const byJob = new Map<string | null, UsageReport["byJob"][number]>();
  for (const row of usageRows(db, from, to, provider)) {
    let value: unknown = null;
    try {
      value = JSON.parse(row.usageJson ?? "null");
    } catch {
      /* Unknown/corrupt usage is unreported, never zero cost. */
    }
    const parsed = runUsageSchema.safeParse(value);
    const usage = parsed.success ? parsed.data : null;
    const reported = usage?.rounds ?? (usage ? 1 : 0);
    const priced = usage?.pricedRounds ?? (usage?.costUsd !== undefined ? 1 : 0);
    const calls = Math.max(row.providerCalls, reported);
    if (!byProfile.has(row.profileId))
      byProfile.set(row.profileId, {
        id: row.profileId,
        name: row.profileName ?? "Unknown profile",
        usage: empty(),
      });
    if (!byJob.has(row.jobId))
      byJob.set(row.jobId, {
        id: row.jobId,
        name: row.jobId ? (row.jobName ?? "Unknown job") : "Unscheduled runs",
        usage: empty(),
      });
    for (const target of [
      totals,
      byProfile.get(row.profileId)!.usage,
      byJob.get(row.jobId)!.usage,
    ]) {
      target.runs++;
      if (["completed", "failed", "cancelled", "running"].includes(row.status))
        target[row.status as "completed" | "failed" | "cancelled" | "running"]++;
      if (usage) {
        target.runsWithUsage++;
        target.promptTokens += usage.promptTokens;
        target.completionTokens += usage.completionTokens;
        target.totalTokens += usage.totalTokens;
        if (usage.costUsd !== undefined)
          target.knownCostUsd = (target.knownCostUsd ?? 0) + usage.costUsd;
      } else target.runsWithoutUsage++;
      target.providerCalls += calls;
      target.reportedCalls += reported;
      target.pricedCalls += priced;
      if (
        !usage ||
        usage.costUsd === undefined ||
        usage.rounds === undefined ||
        usage.pricedRounds === undefined ||
        priced < calls ||
        reported < calls
      )
        target.incompleteCostRuns++;
    }
  }
  const sort = (rows: UsageReport["byProfile"]) =>
    rows.sort(
      (a, b) =>
        (b.usage.knownCostUsd ?? 0) - (a.usage.knownCostUsd ?? 0) || a.name.localeCompare(b.name),
    );
  return usageReportSchema.parse({
    from: from.toISOString(),
    to: to.toISOString(),
    provider,
    generatedAt: new Date().toISOString(),
    totals,
    byProfile: sort([...byProfile.values()]),
    byJob: sort([...byJob.values()]),
  });
}

export function registerUsageRoutes(app: FastifyInstance, db: VektorDatabase) {
  app.get("/api/usage", async (request) => {
    const query = z
      .object({
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        provider: z.enum(["openrouter", "stub", "unknown", "all"]).default("openrouter"),
      })
      .strict()
      .parse(request.query);
    const from = new Date(query.from ?? 0);
    const to = new Date(query.to ?? Date.now());
    if (from >= to) throw new RuntimeError("The usage period must end after it starts.");
    return usageReport(db, from, to, query.provider);
  });
}
