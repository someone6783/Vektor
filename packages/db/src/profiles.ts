import { randomUUID } from "node:crypto";
import { asc, eq, isNull } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { profiles } from "./schema.js";

export type TerminalMode = "no-terminal" | "basic" | "full-access";
export type ProfileColor = "emerald" | "sky" | "violet" | "amber" | "rose";

export interface ProfileRecord {
  id: string;
  name: string;
  color: ProfileColor;
  systemPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  terminalMode: TerminalMode;
  tools: string[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CreateProfileRecordInput {
  name: string;
  model: string;
  systemPrompt?: string;
  color?: ProfileColor;
  temperature?: number;
  maxTokens?: number;
  terminalMode?: TerminalMode;
  tools?: string[];
}

export interface UpdateProfileRecordInput {
  name?: string;
  model?: string;
  systemPrompt?: string;
  color?: ProfileColor;
  temperature?: number;
  maxTokens?: number;
  terminalMode?: TerminalMode;
  tools?: string[];
  archived?: boolean;
}

export const DEFAULT_PROFILE_MODEL = "openrouter/auto";
export const DEFAULT_PROFILE_NAME = "Default";

interface ProfileParams {
  temperature?: number;
  maxTokens?: number;
}

function parseParams(value: string): Required<ProfileParams> {
  let parsed: ProfileParams = {};
  try {
    parsed = JSON.parse(value) as ProfileParams;
  } catch {
    parsed = {};
  }

  return {
    temperature:
      typeof parsed.temperature === "number" && Number.isFinite(parsed.temperature)
        ? Math.min(2, Math.max(0, parsed.temperature))
        : 0.7,
    maxTokens:
      typeof parsed.maxTokens === "number" && Number.isInteger(parsed.maxTokens)
        ? parsed.maxTokens
        : 2048,
  };
}

function parseTools(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toRecord(row: typeof profiles.$inferSelect): ProfileRecord {
  const params = parseParams(row.paramsJson);

  return {
    id: row.id,
    name: row.name,
    color: row.color as ProfileColor,
    systemPrompt: row.systemPrompt,
    model: row.model,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    terminalMode: row.terminalMode as TerminalMode,
    tools: parseTools(row.toolsJson),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    archivedAt: row.archivedAt?.getTime() ?? null,
  };
}

function paramsJson(input: { temperature?: number; maxTokens?: number }): string {
  return JSON.stringify({
    temperature: input.temperature ?? 0.7,
    maxTokens: input.maxTokens ?? 2048,
  });
}

export function listProfiles(
  db: VektorDatabase,
  options: { includeArchived?: boolean } = {},
): ProfileRecord[] {
  const rows = db
    .select()
    .from(profiles)
    .where(options.includeArchived ? undefined : isNull(profiles.archivedAt))
    .orderBy(asc(profiles.createdAt))
    .all();

  return rows.map(toRecord);
}

export function getProfile(db: VektorDatabase, id: string): ProfileRecord | undefined {
  const row = db.select().from(profiles).where(eq(profiles.id, id)).get();
  return row ? toRecord(row) : undefined;
}

export function createProfile(db: VektorDatabase, input: CreateProfileRecordInput): ProfileRecord {
  const now = new Date();
  const row = {
    id: randomUUID(),
    name: input.name,
    color: input.color ?? "emerald",
    systemPrompt: input.systemPrompt ?? "",
    model: input.model,
    paramsJson: paramsJson(input),
    terminalMode: input.terminalMode ?? "no-terminal",
    toolsJson: JSON.stringify(input.tools ?? []),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };

  db.insert(profiles).values(row).run();
  return toRecord(row);
}

export function updateProfile(
  db: VektorDatabase,
  id: string,
  patch: UpdateProfileRecordInput,
): ProfileRecord | undefined {
  const existing = getProfile(db, id);
  if (!existing) {
    return undefined;
  }

  const now = new Date();
  const set: Partial<typeof profiles.$inferInsert> = { updatedAt: now };

  if (patch.name !== undefined) set.name = patch.name;
  if (patch.model !== undefined) set.model = patch.model;
  if (patch.systemPrompt !== undefined) set.systemPrompt = patch.systemPrompt;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.terminalMode !== undefined) set.terminalMode = patch.terminalMode;
  if (patch.tools !== undefined) set.toolsJson = JSON.stringify(patch.tools);
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? now : null;
  if (patch.temperature !== undefined || patch.maxTokens !== undefined) {
    set.paramsJson = paramsJson({
      temperature: patch.temperature ?? existing.temperature,
      maxTokens: patch.maxTokens ?? existing.maxTokens,
    });
  }

  db.update(profiles).set(set).where(eq(profiles.id, id)).run();
  return getProfile(db, id);
}

export function archiveProfile(db: VektorDatabase, id: string): boolean {
  return updateProfile(db, id, { archived: true }) !== undefined;
}

export function ensureDefaultProfile(db: VektorDatabase): ProfileRecord {
  const existing = listProfiles(db, { includeArchived: true });
  if (existing.length > 0) {
    return existing[0]!;
  }

  return createProfile(db, {
    name: DEFAULT_PROFILE_NAME,
    model: DEFAULT_PROFILE_MODEL,
    systemPrompt: "You are Vektor, a concise local assistant. Use Markdown when it helps.",
  });
}
