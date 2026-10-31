import { z } from "zod";
import { attachmentSchema, contextEstimateSchema } from "./attachments.js";

const isoDateSchema = z.string().min(1);

export const profileColorSchema = z.enum(["emerald", "sky", "violet", "amber", "rose"]);

export type ProfileColor = z.infer<typeof profileColorSchema>;

export const terminalModeSchema = z.enum(["no-terminal", "basic", "full-access"]);

export type TerminalMode = z.infer<typeof terminalModeSchema>;

export const runStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const messageRoleSchema = z.enum(["system", "user", "assistant"]);

export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageStatusSchema = z.enum(["complete", "cancelled", "failed"]);

export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const modelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextLength: z.number().int().positive().optional(),
  supportsImages: z.boolean().optional(),
});

export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: profileColorSchema,
  systemPrompt: z.string(),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
  terminalMode: terminalModeSchema,
  tools: z.array(z.string()),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  archivedAt: isoDateSchema.nullable(),
});

export type Profile = z.infer<typeof profileSchema>;

export const channelKindSchema = z.enum(["channel", "dm"]);

export const channelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  topic: z.string(),
  kind: channelKindSchema,
  profileId: z.string().min(1).nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  archivedAt: isoDateSchema.nullable(),
});

export type Channel = z.infer<typeof channelSchema>;

export const messageSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  role: messageRoleSchema,
  content: z.string(),
  status: messageStatusSchema,
  runId: z.string().min(1).nullable(),
  createdAt: isoDateSchema,
  attachments: z.array(attachmentSchema).default([]),
});

export type Message = z.infer<typeof messageSchema>;

export const runUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});

export type RunUsage = z.infer<typeof runUsageSchema>;

export const runSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  profileId: z.string().min(1),
  userMessageId: z.string().min(1),
  model: z.string().min(1),
  runner: z.enum(["native", "cli"]),
  status: runStatusSchema,
  error: z.string().nullable(),
  usage: runUsageSchema.nullable(),
  startedAt: isoDateSchema,
  endedAt: isoDateSchema.nullable(),
  context: contextEstimateSchema.nullable().default(null),
});

export type Run = z.infer<typeof runSchema>;

export const settingsSchema = z.object({
  openRouterConfigured: z.boolean(),
  openRouterSource: z.enum(["env", "stored", "none"]),
  defaultModel: z.string().min(1),
  models: z.array(modelInfoSchema),
  modelsFetchedAt: isoDateSchema.nullable(),
});

export type SettingsView = z.infer<typeof settingsSchema>;

export const updateSettingsSchema = z
  .object({
    openRouterKey: z.string().min(8).nullable().optional(),
    defaultModel: z.string().min(1).max(200).optional(),
  })
  .strict();

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const createProfileSchema = z
  .object({
    name: z.string().min(1).max(80),
    model: z.string().min(1).max(200),
    systemPrompt: z.string().max(20_000).optional(),
    color: profileColorSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(200_000).optional(),
    terminalMode: terminalModeSchema.optional(),
    tools: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();

export type CreateProfileInput = z.infer<typeof createProfileSchema>;

export const updateProfileSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    model: z.string().min(1).max(200).optional(),
    systemPrompt: z.string().max(20_000).optional(),
    color: profileColorSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(200_000).optional(),
    terminalMode: terminalModeSchema.optional(),
    tools: z.array(z.string().min(1)).max(50).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const createChannelSchema = z
  .object({
    name: z.string().min(1).max(80),
    kind: channelKindSchema.optional(),
    topic: z.string().max(500).optional(),
    profileId: z.string().min(1).optional(),
  })
  .strict();

export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    topic: z.string().max(500).optional(),
    profileId: z.string().min(1).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

export const sendMessageSchema = z
  .object({
    content: z.string().max(100_000),
    profileId: z.string().min(1).optional(),
    model: z.string().min(1).max(200).optional(),
    attachmentIds: z.array(z.string().uuid()).max(50).optional(),
    allowTruncation: z.boolean().optional(),
  })
  .strict();

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const messagesResponseSchema = z.object({
  messages: z.array(messageSchema),
  nextBefore: isoDateSchema.nullable(),
  activeRun: runSchema.nullable(),
  lastRun: runSchema.nullable().default(null),
});

export type MessagesResponse = z.infer<typeof messagesResponseSchema>;

export const sendMessageResponseSchema = z.object({
  message: messageSchema,
  run: runSchema,
});

export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;
