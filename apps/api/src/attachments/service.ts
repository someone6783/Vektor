import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  channelFileUsage,
  createAttachment,
  deleteAttachment,
  type AttachmentRecord,
  type VektorDatabase,
} from "@vektor/db";
import type { Attachment } from "@vektor/shared";
import { AttachmentError, extractAttachment } from "./extract.js";

export function toAttachment(record: AttachmentRecord): Attachment {
  return {
    id: record.id,
    channelId: record.channelId,
    filename: record.filename,
    mime: record.mime,
    size: record.size,
    kind: record.kind as Attachment["kind"],
    included: record.included,
    textPreview: record.extractedText.slice(0, 4000),
    ...(record.width ? { width: record.width } : {}),
    ...(record.height ? { height: record.height } : {}),
    createdAt: record.createdAt.toISOString(),
  };
}

export class AttachmentService {
  private readonly uploading = new Set<string>();
  constructor(
    readonly db: VektorDatabase,
    readonly dataDir: string,
    readonly maxFileBytes = 25 * 1024 * 1024,
    readonly channelFileBytes = 250 * 1024 * 1024,
  ) {}

  reserve(channelId: string): () => void {
    if (this.uploading.has(channelId) || this.uploading.size >= 2)
      throw new AttachmentError("Another upload is processing. Try again shortly.", 409);
    this.uploading.add(channelId);
    return () => this.uploading.delete(channelId);
  }

  async save(channelId: string, rawFilename: string, buffer: Buffer): Promise<AttachmentRecord> {
    const filename = basename(rawFilename.replaceAll("\\", "/"))
      .split("")
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join("")
      .slice(0, 200);
    if (!filename) throw new AttachmentError("A filename is required.");
    if (buffer.length > this.maxFileBytes)
      throw new AttachmentError("File exceeds the configured upload size limit.", 413);
    const usage = channelFileUsage(this.db, channelId);
    if (usage.bytes + buffer.length > this.channelFileBytes || usage.count >= 50)
      throw new AttachmentError(
        "This channel's file storage limit has been reached. Remove files before uploading more.",
        413,
      );
    const extracted = await extractAttachment(filename, buffer);
    const id = randomUUID();
    const path = this.path(id);
    await writeFile(path, buffer, { mode: 0o600, flag: "wx" });
    try {
      return createAttachment(this.db, {
        id,
        channelId,
        filename,
        size: buffer.length,
        ...extracted,
        createdAt: new Date(),
      });
    } catch (error) {
      await unlink(path);
      throw error;
    }
  }

  path(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AttachmentError("Attachment not found.", 404);
    return join(this.dataDir, "files", id);
  }

  async read(record: AttachmentRecord): Promise<Buffer> {
    return readFile(this.path(record.id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new AttachmentError(
          "The attachment file is missing. Remove it and upload it again.",
          410,
        );
      throw error;
    });
  }

  async remove(record: AttachmentRecord): Promise<void> {
    await unlink(this.path(record.id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    deleteAttachment(this.db, record.id);
  }
}
