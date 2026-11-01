import { z } from "zod";

export const usageSummarySchema = z.object({
  runs: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  runsWithUsage: z.number().int().nonnegative(),
  runsWithoutUsage: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  providerCalls: z.number().int().nonnegative(),
  reportedCalls: z.number().int().nonnegative(),
  pricedCalls: z.number().int().nonnegative(),
  incompleteCostRuns: z.number().int().nonnegative(),
  knownCostUsd: z.number().nonnegative().nullable(),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export const usageReportSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  generatedAt: z.string().datetime(),
  provider: z.enum(["openrouter", "stub", "unknown", "all"]),
  totals: usageSummarySchema,
  byProfile: z.array(
    z.object({ id: z.string().nullable(), name: z.string(), usage: usageSummarySchema }),
  ),
  byJob: z.array(
    z.object({ id: z.string().nullable(), name: z.string(), usage: usageSummarySchema }),
  ),
});
export type UsageReport = z.infer<typeof usageReportSchema>;
