import type { FastifyInstance } from "fastify";
import {
  createMessage,
  createRun,
  deleteAssistantMessageForRun,
  getActiveRun,
  getLatestRun,
  getChannel,
  getMessage,
  getProfile,
  getRun,
  listMessages,
  listProfiles,
  listMessageAttachments,
  linkMessageAttachments,
  type MessageRecord,
  type VektorDatabase,
} from "@vektor/db";
import {
  makeApiError,
  messagesResponseSchema,
  sendMessageSchema,
  contextRequestSchema,
  contextReasoning,
  type SendMessageResponse,
} from "@vektor/shared";
import type { RunManager } from "../runs/run-manager.js";
import { toMessage, toRun } from "../serializers.js";
import { toAttachment } from "../attachments/service.js";
import { checkContextBudget, type ContextService } from "../context.js";
import { AttachmentError } from "../attachments/extract.js";

function parseBefore(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function registerMessageRoutes(
  app: FastifyInstance,
  db: VektorDatabase,
  runManager: RunManager,
  context: ContextService,
): void {
  const serializeMessage = (record: MessageRecord) => ({
    ...toMessage(record),
    attachments: listMessageAttachments(db, record.id).map(toAttachment),
  });

  app.post("/api/channels/:channelId/context", async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    const channel = getChannel(db, channelId);
    if (!channel) return reply.code(404).send(makeApiError("not_found", "Channel not found."));
    const input = contextRequestSchema.parse(request.body);
    return context.prepare(channelId, input, channel.profileId ?? listProfiles(db)[0]?.id ?? null)
      .estimate;
  });
  app.get("/api/channels/:channelId/messages", async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    const query = request.query as { before?: string; limit?: string };

    if (!getChannel(db, channelId)) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Channel not found.", { requestId: request.id }));
    }

    const limit = query.limit ? Number(query.limit) : undefined;
    const page = listMessages(db, channelId, {
      before: parseBefore(query.before),
      ...(limit !== undefined && Number.isInteger(limit) ? { limit } : {}),
    });
    const activeRun = getActiveRun(db, channelId);
    const lastRun = getLatestRun(db, channelId);

    return messagesResponseSchema.parse({
      messages: page.messages.map(serializeMessage),
      nextBefore: page.nextBefore !== null ? new Date(page.nextBefore).toISOString() : null,
      activeRun: activeRun ? toRun(activeRun) : null,
      lastRun: lastRun ? toRun(lastRun) : null,
    });
  });

  app.post("/api/channels/:channelId/messages", async (request, reply) => {
    runManager.assertCanStart();
    const { channelId } = request.params as { channelId: string };
    const input = sendMessageSchema.parse(request.body);

    const channel = getChannel(db, channelId);
    if (!channel) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Channel not found.", { requestId: request.id }));
    }

    if (getActiveRun(db, channelId)) {
      return reply.code(409).send(
        makeApiError("run_active", "A run is already active in this channel.", {
          requestId: request.id,
        }),
      );
    }

    const profileId = input.profileId ?? channel.profileId ?? listProfiles(db)[0]?.id;
    if (!profileId) {
      return reply.code(409).send(
        makeApiError("no_profile", "Create a profile before sending a message.", {
          requestId: request.id,
        }),
      );
    }

    const profile = getProfile(db, profileId);
    if (!profile || profile.archivedAt !== null) {
      return reply.code(400).send(
        makeApiError("invalid_profile", "The selected profile is not available.", {
          requestId: request.id,
        }),
      );
    }

    const model = input.model ?? profile.model;
    const prepared = context.prepare(channelId, input, profileId);
    if (!input.content.trim() && !prepared.attachments.length)
      throw new AttachmentError("Write a message or include an attachment before sending.");
    checkContextBudget(prepared.estimate, input.allowTruncation);
    const chatMessages = await context.messages(prepared);
    runManager.assertCanStart();
    if (getActiveRun(db, channelId))
      return reply
        .code(409)
        .send(makeApiError("run_active", "A run is already active in this channel."));

    const message = createMessage(db, {
      channelId,
      role: "user",
      content: input.content,
    });
    linkMessageAttachments(
      db,
      message.id,
      prepared.attachments.map((file) => file.id),
    );

    const run = createRun(db, {
      channelId,
      profileId,
      userMessageId: message.id,
      model,
      context: prepared.estimate,
      terminalMode: prepared.profile.terminalMode,
    });

    runManager.start({
      run,
      profile: prepared.profile,
      messages: chatMessages,
    });

    const response: SendMessageResponse = {
      message: serializeMessage(message),
      run: toRun(run),
    };

    return reply.code(201).send(response);
  });

  app.post("/api/runs/:runId/retry", async (request, reply) => {
    runManager.assertCanStart();
    const { runId } = request.params as { runId: string };
    const previous = getRun(db, runId);

    if (!previous) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Run not found.", { requestId: request.id }));
    }

    if (runManager.isActive(runId)) {
      return reply.code(409).send(
        makeApiError("run_active", "Cancel the current run before retrying.", {
          requestId: request.id,
        }),
      );
    }

    const channel = getChannel(db, previous.channelId);
    const profile = getProfile(db, previous.profileId);
    const userMessage = getMessage(db, previous.userMessageId);

    if (!channel || !profile || !userMessage) {
      return reply.code(409).send(
        makeApiError("run_retry_unavailable", "This run can no longer be retried.", {
          requestId: request.id,
        }),
      );
    }

    if (getActiveRun(db, channel.id))
      return reply
        .code(409)
        .send(makeApiError("run_active", "A run is already active in this channel."));
    const retryOptions = sendMessageSchema
      .pick({ allowTruncation: true })
      .parse(request.body ?? {});
    const retryInput = {
      content: userMessage.content,
      profileId: profile.id,
      model: previous.model,
      reasoning: contextReasoning(previous.context),
      attachmentIds: listMessageAttachments(db, userMessage.id)
        .filter((file) => file.included)
        .map((file) => file.id),
    };
    const prepared = context.prepare(
      channel.id,
      retryInput,
      profile.id,
      userMessage.id,
      previous.includeHistory,
    );
    checkContextBudget(prepared.estimate, retryOptions.allowTruncation);
    const chatMessages = await context.messages(prepared);
    runManager.assertCanStart();
    if (getActiveRun(db, channel.id))
      return reply
        .code(409)
        .send(makeApiError("run_active", "A run is already active in this channel."));

    deleteAssistantMessageForRun(db, runId);

    const run = createRun(db, {
      channelId: channel.id,
      profileId: profile.id,
      userMessageId: userMessage.id,
      model: previous.model,
      includeHistory: previous.includeHistory,
      jobId: previous.jobId,
      context: prepared.estimate,
      terminalMode: prepared.profile.terminalMode,
    });

    runManager.start({
      run,
      profile: prepared.profile,
      messages: chatMessages,
    });

    return reply.code(201).send({ run: toRun(run) });
  });

  app.get("/api/runs/:runId/context", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = getRun(db, runId);
    if (!run) return reply.code(404).send(makeApiError("not_found", "Run not found."));
    const channel = getChannel(db, run.channelId);
    const message = getMessage(db, run.userMessageId);
    if (!channel || !message)
      return reply
        .code(409)
        .send(makeApiError("run_retry_unavailable", "This run can no longer be retried."));
    return context.prepare(
      channel.id,
      {
        content: message.content,
        profileId: run.profileId,
        model: run.model,
        reasoning: contextReasoning(run.context),
        attachmentIds: listMessageAttachments(db, message.id)
          .filter((file) => file.included)
          .map((file) => file.id),
      },
      run.profileId,
      message.id,
      run.includeHistory,
    ).estimate;
  });

  app.post("/api/runs/:runId/cancel", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = getRun(db, runId);

    if (!run) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Run not found.", { requestId: request.id }));
    }

    if (run.status !== "running") {
      return reply.code(409).send(
        makeApiError("run_finished", "This run has already finished.", {
          requestId: request.id,
        }),
      );
    }

    if (!runManager.cancel(runId)) {
      return reply.code(409).send(
        makeApiError("run_not_active", "This run is not active on this server.", {
          requestId: request.id,
        }),
      );
    }

    return reply.code(202).send({ cancelled: true });
  });
}
