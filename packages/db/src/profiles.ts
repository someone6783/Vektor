import { randomUUID } from "node:crypto";
import { asc, eq, isNull } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { profiles } from "./schema.js";

export type RunnerId = "native" | "codex" | "cli" | `acp:${string}`;

export type TerminalMode = "no-terminal" | "basic" | "full-access" | "full-unrestricted";
export type ProfileColor = "emerald" | "sky" | "violet" | "amber" | "rose";
export interface BrowserPermissions {
  session: "default" | "separate";
  display: "headless" | "window";
  mode: "off" | "observe" | "interactive";
  allowedOrigins: string[];
  localOrigins: string[];
}

export interface ComputerApp {
  name: string;
  command: string;
  args: string[];
}
export interface ComputerPermissions {
  maxActions: number;
  maxDurationMs: number;
  artifactDays: number;
  mode: "off" | "observe" | "control";
  session: "isolated";
  width: number;
  height: number;
  apps: ComputerApp[];
}

export interface ProfileRecord {
  runner?: RunnerId;
  id: string;
  name: string;
  color: ProfileColor;
  systemPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  terminalMode: TerminalMode;
  tools: string[];
  browser?: BrowserPermissions;
  computer?: ComputerPermissions;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CreateProfileRecordInput {
  runner?: RunnerId;
  browser?: BrowserPermissions;
  computer?: ComputerPermissions;
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
  runner?: RunnerId;
  browser?: BrowserPermissions;
  computer?: ComputerPermissions;
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
    runner: row.runner as RunnerId,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    terminalMode: row.terminalMode as TerminalMode,
    tools: parseTools(row.toolsJson),
    browser: parseBrowser(row.browserJson),
    computer: parseComputer(row.computerJson),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    archivedAt: row.archivedAt?.getTime() ?? null,
  };
}

function parseBrowser(value: string): BrowserPermissions {
  const off: BrowserPermissions = {
    mode: "off",
    session: "separate",
    display: "headless",
    allowedOrigins: [],
    localOrigins: [],
  };
  try {
    const parsed = JSON.parse(value) as BrowserPermissions;
    if (
      !["off", "observe", "interactive"].includes(parsed.mode) ||
      !Array.isArray(parsed.allowedOrigins) ||
      !Array.isArray(parsed.localOrigins)
    )
      return off;
    if (parsed.session !== undefined && !["default", "separate"].includes(parsed.session))
      return off;
    if (parsed.display !== undefined && !["headless", "window"].includes(parsed.display))
      return off;
    return {
      ...parsed,
      session: parsed.session ?? "separate",
      display: parsed.display ?? "headless",
    };
  } catch {
    return off;
  }
}

function parseComputer(value: string): ComputerPermissions {
  const off: ComputerPermissions = {
    mode: "off",
    session: "isolated",
    width: 1280,
    height: 800,
    apps: [],
    maxActions: 60,
    maxDurationMs: 300_000,
    artifactDays: 7,
  };
  try {
    const parsed = JSON.parse(value) as ComputerPermissions;
    if (!["off", "observe", "control"].includes(parsed.mode) || !Array.isArray(parsed.apps))
      return off;
    const apps = parsed.apps
      .filter(
        (app) =>
          app &&
          typeof app.name === "string" &&
          typeof app.command === "string" &&
          Array.isArray(app.args) &&
          app.args.every((arg) => typeof arg === "string"),
      )
      .slice(0, 5)
      .map((app) => ({ name: app.name, command: app.command, args: app.args.slice(0, 32) }));
    return {
      mode: parsed.mode,
      session: "isolated",
      width:
        Number.isInteger(parsed.width) && parsed.width >= 640 && parsed.width <= 2560
          ? parsed.width
          : 1280,
      height:
        Number.isInteger(parsed.height) && parsed.height >= 480 && parsed.height <= 1600
          ? parsed.height
          : 800,
      apps,
      maxActions:
        Number.isInteger(parsed.maxActions) && parsed.maxActions! >= 1 && parsed.maxActions! <= 200
          ? parsed.maxActions
          : 60,
      maxDurationMs:
        Number.isInteger(parsed.maxDurationMs) &&
        parsed.maxDurationMs! >= 1000 &&
        parsed.maxDurationMs! <= 1_800_000
          ? parsed.maxDurationMs
          : 300_000,
      artifactDays:
        Number.isInteger(parsed.artifactDays) &&
        parsed.artifactDays! >= 0 &&
        parsed.artifactDays! <= 30
          ? parsed.artifactDays
          : 7,
    };
  } catch {
    return off;
  }
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
    runner: input.runner ?? "native",
    paramsJson: paramsJson(input),
    terminalMode: input.terminalMode ?? "no-terminal",
    toolsJson: JSON.stringify(input.tools ?? []),
    browserJson: JSON.stringify(
      input.browser ?? { mode: "off", allowedOrigins: [], localOrigins: [] },
    ),
    computerJson: JSON.stringify(input.computer ?? { mode: "off", apps: [] }),
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

  if (patch.runner !== undefined) set.runner = patch.runner;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.model !== undefined) set.model = patch.model;
  if (patch.systemPrompt !== undefined) set.systemPrompt = patch.systemPrompt;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.terminalMode !== undefined) set.terminalMode = patch.terminalMode;
  if (patch.tools !== undefined) set.toolsJson = JSON.stringify(patch.tools);
  if (patch.browser !== undefined) set.browserJson = JSON.stringify(patch.browser);
  if (patch.computer !== undefined) set.computerJson = JSON.stringify(patch.computer);
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
