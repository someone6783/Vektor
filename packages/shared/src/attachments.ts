import { reasoningEffortSchema } from "./reasoning.js";
import { z } from "zod";

export const attachmentSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(["text", "document", "image"]),
  included: z.boolean(),
  textPreview: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  createdAt: z.string(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const contextEstimateSchema = z.object({
  model: z.string(),
  reasoning: reasoningEffortSchema.optional(),
  contextWindow: z.number(),
  windowSource: z.enum(["model", "fallback"]),
  originalInputTokens: z.number(),
  inputTokens: z.number(),
  reservedOutputTokens: z.number(),
  availableInputTokens: z.number(),
  attachmentTokens: z.number(),
  selectedAttachments: z.number(),
  droppedMessages: z.number(),
  exceedsBudget: z.boolean(),
  requiresTruncation: z.boolean(),
  warnings: z.array(z.string()),
});
export type ContextEstimate = z.infer<typeof contextEstimateSchema>;

export const contextRequestSchema = z
  .object({
    content: z.string().max(100_000).default(""),
    profileId: z.string().min(1).optional(),
    model: z.string().min(1).max(200).optional(),
    reasoning: reasoningEffortSchema.optional(),
    attachmentIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict();
export type ContextRequest = z.infer<typeof contextRequestSchema>;
