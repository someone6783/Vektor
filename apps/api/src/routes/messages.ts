import type { FastifyInstance } from "fastify";
import {
  createMessage,
  createRun,
  deleteAssistantMessageForRun,
  getActiveRun,
  getChannel,
  getMessage,
  getProfile,
  getRun,
  listMessages,
  listProfiles,
  listRecentMessages,
  type MessageRecord,
  type VektorDatabase,
} from "@vektor/db";
import {
  makeApiError,
  messagesResponseSchema,
  sendMessageSchema,
  type SendMessageResponse,
} from "@vektor/shared";
import type { ChatMessage } from "../providers/index.js";
import type { RunManager } from "../runs/run-manager.js";
import { toMessage, toRun } from "../serializers.js";

function toChatMessage(record: MessageRecord): ChatMessage {
  return {
    role: record.role === "system" ? "system" : record.role,
    content: record.content,
  };
}

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
): void {
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

    return messagesResponseSchema.parse({
      messages: page.messages.map(toMessage),
      nextBefore: page.nextBefore !== null ? new Date(page.nextBefore).toISOString() : null,
      activeRun: activeRun ? toRun(activeRun) : null,
    });
  });

  app.post("/api/channels/:channelId/messages", async (request, reply) => {
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
    const history = listRecentMessages(db, channelId, 19).map(toChatMessage);

    const message = createMessage(db, {
      channelId,
      role: "user",
      content: input.content,
    });

    const run = createRun(db, {
      channelId,
      profileId,
      userMessageId: message.id,
      model,
    });

    runManager.start({
      run,
      profile,
      messages: [...history, { role: "user", content: input.content }],
    });

    const response: SendMessageResponse = {
      message: toMessage(message),
      run: toRun(run),
    };

    return reply.code(201).send(response);
  });

  app.post("/api/runs/:runId/retry", async (request, reply) => {
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

    deleteAssistantMessageForRun(db, runId);
    const history = listRecentMessages(db, channel.id, 20).map(toChatMessage);

    const run = createRun(db, {
      channelId: channel.id,
      profileId: profile.id,
      userMessageId: userMessage.id,
      model: previous.model,
    });

    runManager.start({
      run,
      profile,
      messages: history,
    });

    return reply.code(201).send({ run: toRun(run) });
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
