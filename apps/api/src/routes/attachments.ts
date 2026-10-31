import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getActiveRun,
  getAttachment,
  getChannel,
  listAttachments,
  setAttachmentIncluded,
} from "@vektor/db";
import { AttachmentError } from "../attachments/extract.js";
import { type AttachmentService, toAttachment } from "../attachments/service.js";

export async function registerAttachmentRoutes(
  app: FastifyInstance,
  service: AttachmentService,
): Promise<void> {
  await app.register(multipart, {
    limits: { fileSize: service.maxFileBytes, files: 1, fields: 0, parts: 1 },
  });
  app.get("/api/channels/:channelId/attachments", async (request) => {
    const { channelId } = request.params as { channelId: string };
    if (!getChannel(service.db, channelId)) throw new AttachmentError("Channel not found.", 404);
    return {
      attachments: listAttachments(service.db, channelId).map(toAttachment),
      limits: {
        maxFileBytes: service.maxFileBytes,
        channelFileBytes: service.channelFileBytes,
        maxFiles: 50,
      },
    };
  });
  app.post("/api/channels/:channelId/attachments", async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    if (!getChannel(service.db, channelId)) throw new AttachmentError("Channel not found.", 404);
    const release = service.reserve(channelId);
    try {
      const file = await request.file();
      if (!file) throw new AttachmentError("Choose a file to upload.");
      const buffer = await file.toBuffer();
      const attachment = await service.save(channelId, file.filename, buffer);
      return reply.code(201).send({ attachment: toAttachment(attachment) });
    } finally {
      release();
    }
  });
  app.patch("/api/attachments/:attachmentId", async (request) => {
    const { attachmentId } = request.params as { attachmentId: string };
    const record = getAttachment(service.db, attachmentId);
    if (!record) throw new AttachmentError("Attachment not found.", 404);
    const { included } = z.object({ included: z.boolean() }).strict().parse(request.body);
    setAttachmentIncluded(service.db, attachmentId, included);
    return { attachment: toAttachment({ ...record, included }) };
  });
  app.get("/api/attachments/:attachmentId/content", async (request, reply) => {
    const { attachmentId } = request.params as { attachmentId: string };
    const record = getAttachment(service.db, attachmentId);
    if (!record) throw new AttachmentError("Attachment not found.", 404);
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `${record.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
      )
      .type(record.mime)
      .send(await service.read(record));
  });
  app.delete("/api/attachments/:attachmentId", async (request, reply) => {
    const { attachmentId } = request.params as { attachmentId: string };
    const record = getAttachment(service.db, attachmentId);
    if (!record) throw new AttachmentError("Attachment not found.", 404);
    if (getActiveRun(service.db, record.channelId))
      throw new AttachmentError("Stop the active run before removing files.", 409);
    await service.remove(record);
    return reply.code(204).send();
  });
}
