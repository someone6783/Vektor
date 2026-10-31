import { z } from "zod";

const runEventBaseSchema = z.object({
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
});

export const runStartedEventSchema = runEventBaseSchema.extend({
  type: z.literal("run.started"),
  conversationId: z.string().nullable(),
  profileId: z.string().nullable(),
  runner: z.enum(["native", "cli"]),
});

export const messageDeltaEventSchema = runEventBaseSchema.extend({
  type: z.literal("message.delta"),
  text: z.string(),
});

export const toolRequestedEventSchema = runEventBaseSchema.extend({
  type: z.literal("tool.requested"),
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

export const toolOutputEventSchema = runEventBaseSchema.extend({
  type: z.literal("tool.output"),
  toolCallId: z.string().min(1),
  output: z.string(),
  isError: z.boolean(),
});

export const approvalRequestedEventSchema = runEventBaseSchema.extend({
  type: z.literal("approval.requested"),
  approvalId: z.string().min(1),
  toolCallId: z.string().min(1),
  command: z.string().min(1),
});

export const usageEventSchema = runEventBaseSchema.extend({
  type: z.literal("usage"),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});

export const runCompletedEventSchema = runEventBaseSchema.extend({
  type: z.literal("run.completed"),
  messageId: z.string().optional(),
});

export const runFailedEventSchema = runEventBaseSchema.extend({
  type: z.literal("run.failed"),
  error: z.string().min(1),
  code: z.string().optional(),
});

export const runCancelledEventSchema = runEventBaseSchema.extend({
  type: z.literal("run.cancelled"),
  reason: z.string().optional(),
});

export const runEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  messageDeltaEventSchema,
  toolRequestedEventSchema,
  toolOutputEventSchema,
  approvalRequestedEventSchema,
  usageEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runCancelledEventSchema,
]);

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent["type"];

export const RUN_EVENT_TYPES = [
  "run.started",
  "message.delta",
  "tool.requested",
  "tool.output",
  "approval.requested",
  "usage",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const satisfies readonly RunEventType[];
