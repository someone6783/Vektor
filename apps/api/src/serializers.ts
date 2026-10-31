import type { ChannelRecord, MessageRecord, ProfileRecord, RunRecord } from "@vektor/db";
import type { Channel, Message, Profile, Run, RunUsage } from "@vektor/shared";
import { contextEstimateSchema } from "@vektor/shared";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}

export function toProfile(record: ProfileRecord): Profile {
  return {
    id: record.id,
    name: record.name,
    color: record.color,
    systemPrompt: record.systemPrompt,
    model: record.model,
    temperature: record.temperature,
    maxTokens: record.maxTokens,
    terminalMode: record.terminalMode,
    tools: record.tools,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    archivedAt: isoOrNull(record.archivedAt),
  };
}

export function toChannel(record: ChannelRecord): Channel {
  return {
    id: record.id,
    name: record.name,
    topic: record.topic,
    kind: record.kind,
    profileId: record.profileId,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    archivedAt: isoOrNull(record.archivedAt),
  };
}

export function toMessage(record: MessageRecord): Message {
  return {
    id: record.id,
    channelId: record.channelId,
    role: record.role,
    content: record.content,
    status: record.status,
    runId: record.runId,
    createdAt: iso(record.createdAt),
    attachments: [],
  };
}

function parseUsage(value: unknown): RunUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const usage = value as Partial<RunUsage>;
  if (
    typeof usage.promptTokens !== "number" ||
    typeof usage.completionTokens !== "number" ||
    typeof usage.totalTokens !== "number"
  ) {
    return null;
  }

  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    ...(typeof usage.costUsd === "number" ? { costUsd: usage.costUsd } : {}),
  };
}

export function toRun(record: RunRecord): Run {
  return {
    id: record.id,
    channelId: record.channelId,
    profileId: record.profileId,
    userMessageId: record.userMessageId,
    model: record.model,
    runner: record.runner,
    status: record.status,
    error: record.error,
    usage: parseUsage(record.usage),
    startedAt: iso(record.startedAt),
    endedAt: isoOrNull(record.endedAt),
    context: contextEstimateSchema.nullable().parse(record.context),
  };
}
