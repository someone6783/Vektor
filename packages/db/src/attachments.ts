import { and, asc, eq, sql } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { attachments, messageAttachments } from "./schema.js";

export type AttachmentRecord = typeof attachments.$inferSelect;

export function createAttachment(
  db: VektorDatabase,
  input: typeof attachments.$inferInsert,
): AttachmentRecord {
  return db.insert(attachments).values(input).returning().get();
}

export function listAttachments(db: VektorDatabase, channelId: string): AttachmentRecord[] {
  return db
    .select()
    .from(attachments)
    .where(eq(attachments.channelId, channelId))
    .orderBy(asc(attachments.createdAt), asc(attachments.id))
    .all();
}

export function getAttachment(db: VektorDatabase, id: string): AttachmentRecord | undefined {
  return db.select().from(attachments).where(eq(attachments.id, id)).get();
}

export function setAttachmentIncluded(db: VektorDatabase, id: string, included: boolean): void {
  db.update(attachments).set({ included }).where(eq(attachments.id, id)).run();
}

export function deleteAttachment(db: VektorDatabase, id: string): void {
  db.delete(attachments).where(eq(attachments.id, id)).run();
}

export function channelFileUsage(
  db: VektorDatabase,
  channelId: string,
): { bytes: number; count: number } {
  const row = db
    .select({
      bytes: sql<number>`coalesce(sum(${attachments.size}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(attachments)
    .where(eq(attachments.channelId, channelId))
    .get();
  return row ?? { bytes: 0, count: 0 };
}

export function linkMessageAttachments(db: VektorDatabase, messageId: string, ids: string[]): void {
  for (const attachmentId of new Set(ids)) {
    db.insert(messageAttachments).values({ messageId, attachmentId }).onConflictDoNothing().run();
  }
}

export function listMessageAttachments(db: VektorDatabase, messageId: string): AttachmentRecord[] {
  return db
    .select({ attachment: attachments })
    .from(attachments)
    .innerJoin(
      messageAttachments,
      and(
        eq(messageAttachments.attachmentId, attachments.id),
        eq(messageAttachments.messageId, messageId),
      ),
    )
    .all()
    .map((row) => row.attachment);
}
