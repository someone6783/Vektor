import { randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { messages } from "./schema.js";

export type MessageRole = "system" | "user" | "assistant";
export type MessageStatus = "complete" | "cancelled" | "failed";

export interface MessageRecord {
  id: string;
  channelId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  runId: string | null;
  createdAt: number;
}

export interface CreateMessageRecordInput {
  channelId: string;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  runId?: string | null;
  createdAt?: number;
}

export interface MessagePage {
  messages: MessageRecord[];
  nextBefore: number | null;
}

function toRecord(row: typeof messages.$inferSelect): MessageRecord {
  return {
    id: row.id,
    channelId: row.channelId,
    role: row.role as MessageRole,
    content: row.content,
    status: row.status as MessageStatus,
    runId: row.runId,
    createdAt: row.createdAt.getTime(),
  };
}

export function listMessages(
  db: VektorDatabase,
  channelId: string,
  options: { before?: number; limit?: number } = {},
): MessagePage {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const conditions = [eq(messages.channelId, channelId)];

  if (options.before !== undefined) {
    conditions.push(lt(messages.createdAt, new Date(options.before)));
  }

  const rows = db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();

  return {
    messages: page.map(toRecord),
    nextBefore: hasMore && page.length > 0 ? page[0]!.createdAt.getTime() : null,
  };
}

export function listRecentMessages(
  db: VektorDatabase,
  channelId: string,
  limit = 20,
): MessageRecord[] {
  const rows = db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channelId), eq(messages.status, "complete")))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit)
    .all();

  return rows.reverse().map(toRecord);
}

export function getMessage(db: VektorDatabase, id: string): MessageRecord | undefined {
  const row = db.select().from(messages).where(eq(messages.id, id)).get();
  return row ? toRecord(row) : undefined;
}

export function createMessage(db: VektorDatabase, input: CreateMessageRecordInput): MessageRecord {
  const row = {
    id: randomUUID(),
    channelId: input.channelId,
    role: input.role,
    content: input.content,
    status: input.status ?? "complete",
    runId: input.runId ?? null,
    createdAt: new Date(input.createdAt ?? Date.now()),
  };

  db.insert(messages).values(row).run();
  return toRecord(row);
}

export function deleteAssistantMessageForRun(db: VektorDatabase, runId: string): boolean {
  const existing = db
    .select()
    .from(messages)
    .where(and(eq(messages.runId, runId), eq(messages.role, "assistant")))
    .get();

  if (!existing) {
    return false;
  }

  db.delete(messages).where(eq(messages.id, existing.id)).run();
  return true;
}

export function deleteMessage(db: VektorDatabase, id: string): boolean {
  const existing = getMessage(db, id);
  if (!existing) {
    return false;
  }

  db.delete(messages).where(eq(messages.id, id)).run();
  return true;
}
