import { randomUUID } from "node:crypto";
import { asc, eq, isNull } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { channels } from "./schema.js";

export type ChannelKind = "channel" | "dm";

export interface ChannelRecord {
  id: string;
  name: string;
  topic: string;
  kind: ChannelKind;
  profileId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CreateChannelRecordInput {
  name: string;
  kind?: ChannelKind;
  topic?: string;
  profileId?: string | null;
}

export interface UpdateChannelRecordInput {
  name?: string;
  topic?: string;
  profileId?: string | null;
  archived?: boolean;
}

function toRecord(row: typeof channels.$inferSelect): ChannelRecord {
  return {
    id: row.id,
    name: row.name,
    topic: row.topic,
    kind: row.kind as ChannelKind,
    profileId: row.profileId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    archivedAt: row.archivedAt?.getTime() ?? null,
  };
}

export function listChannels(
  db: VektorDatabase,
  options: { includeArchived?: boolean } = {},
): ChannelRecord[] {
  const rows = db
    .select()
    .from(channels)
    .where(options.includeArchived ? undefined : isNull(channels.archivedAt))
    .orderBy(asc(channels.archivedAt), asc(channels.createdAt))
    .all();

  return rows.map(toRecord);
}

export function getChannel(db: VektorDatabase, id: string): ChannelRecord | undefined {
  const row = db.select().from(channels).where(eq(channels.id, id)).get();
  return row ? toRecord(row) : undefined;
}

export function createChannel(db: VektorDatabase, input: CreateChannelRecordInput): ChannelRecord {
  const now = new Date();
  const row = {
    id: randomUUID(),
    name: input.name,
    topic: input.topic ?? "",
    kind: input.kind ?? "channel",
    profileId: input.profileId ?? null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };

  db.insert(channels).values(row).run();
  return toRecord(row);
}

export function updateChannel(
  db: VektorDatabase,
  id: string,
  patch: UpdateChannelRecordInput,
): ChannelRecord | undefined {
  const existing = getChannel(db, id);
  if (!existing) {
    return undefined;
  }

  const now = new Date();
  const set: Partial<typeof channels.$inferInsert> = { updatedAt: now };

  if (patch.name !== undefined) set.name = patch.name;
  if (patch.topic !== undefined) set.topic = patch.topic;
  if (patch.profileId !== undefined) set.profileId = patch.profileId;
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? now : null;

  db.update(channels).set(set).where(eq(channels.id, id)).run();
  return getChannel(db, id);
}

export function archiveChannel(db: VektorDatabase, id: string): boolean {
  return updateChannel(db, id, { archived: true }) !== undefined;
}

export function ensureDefaultChannel(db: VektorDatabase, profileId: string): ChannelRecord {
  const existing = listChannels(db);
  if (existing.length > 0) {
    return existing[0]!;
  }

  return createChannel(db, {
    name: "General",
    topic: "Your first Vektor channel",
    profileId,
  });
}
