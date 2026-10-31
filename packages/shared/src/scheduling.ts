import { z } from "zod";

export const scheduleInputSchema = z
  .object({
    schedule: z.string().trim().min(1).max(200),
    timezone: z.string().trim().min(1).max(100),
  })
  .strict();
export const createJobSchema = scheduleInputSchema
  .extend({
    name: z.string().trim().min(1).max(100),
    profileId: z.string().min(1),
    channelId: z.string().min(1),
    prompt: z.string().trim().min(1).max(100_000),
    enabled: z.boolean().default(true),
    catchUp: z.boolean().default(false),
    includeHistory: z.boolean().default(false),
    allowTruncation: z.boolean().default(false),
  })
  .strict();
export const updateJobSchema = createJobSchema
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, "Provide at least one job setting.");
export type CreateJob = z.infer<typeof createJobSchema>;
export type UpdateJob = z.infer<typeof updateJobSchema>;
export const scheduledJobSchema = createJobSchema
  .extend({
    id: z.string(),
    cron: z.string(),
    nextRunAt: z.string().nullable(),
    lastStatus: z.string().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
  })
  .strip();
export type ScheduledJob = z.infer<typeof scheduledJobSchema>;
export const jobRunSchema = z.object({
  id: z.number(),
  jobId: z.string(),
  runId: z.string().nullable(),
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  source: z.enum(["schedule", "catch-up", "manual"]),
  status: z.enum(["running", "completed", "failed", "cancelled", "skipped"]),
  error: z.string().nullable(),
  awaitingApproval: z.boolean().default(false),
});
export type JobRun = z.infer<typeof jobRunSchema>;
export const schedulePreviewSchema = z.object({
  cron: z.string(),
  timezone: z.string(),
  nextRuns: z.array(z.string()),
  explanation: z.string(),
});
export type SchedulePreview = z.infer<typeof schedulePreviewSchema>;
export const schedulerStateSchema = z.object({
  enabled: z.boolean(),
  paused: z.boolean(),
  emergencyStopped: z.boolean(),
  tickMs: z.number(),
});
export type SchedulerState = z.infer<typeof schedulerStateSchema>;
