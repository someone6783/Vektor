import { conversationExecution, executionKey } from "../conversation-execution.js";
import type { FastifyInstance } from "fastify";
import {
  archiveChannel,
  setSetting,
  deleteSetting,
  appendAudit,
  createChannel,
  getChannel,
  getProfile,
  listChannels,
  listProfiles,
  updateChannel,
  type VektorDatabase,
} from "@vektor/db";
import { createChannelSchema, makeApiError, updateChannelSchema } from "@vektor/shared";
import { toChannel } from "../serializers.js";

function includeArchived(value: unknown): boolean {
  return value === "1" || value === "true";
}

export function registerChannelRoutes(
  app: FastifyInstance,
  db: VektorDatabase,
  revokeExecution?: (id: string) => void,
): void {
  const serialize = (channel: Parameters<typeof toChannel>[0]) => ({
    ...toChannel(channel),
    execution: conversationExecution(db, channel.id),
  });
  app.get("/api/channels", async (request) => {
    const query = request.query as { includeArchived?: string };
    return {
      channels: listChannels(db, { includeArchived: includeArchived(query.includeArchived) }).map(
        serialize,
      ),
    };
  });

  app.post("/api/channels", async (request, reply) => {
    const input = createChannelSchema.parse(request.body);
    const profileId = input.profileId ?? listProfiles(db)[0]?.id;

    if (!profileId) {
      return reply.code(409).send(
        makeApiError("no_profile", "Create a profile before creating a channel.", {
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

    const channel = createChannel(db, {
      name: input.name,
      kind: input.kind ?? "channel",
      topic: input.topic ?? "",
      profileId,
    });

    return reply.code(201).send({ channel: serialize(channel) });
  });

  app.patch("/api/channels/:channelId", async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    const input = updateChannelSchema.parse(request.body);

    if (!getChannel(db, channelId)) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Channel not found.", { requestId: request.id }));
    }

    if (input.profileId) {
      const profile = getProfile(db, input.profileId);
      if (!profile || profile.archivedAt !== null) {
        return reply.code(400).send(
          makeApiError("invalid_profile", "The selected profile is not available.", {
            requestId: request.id,
          }),
        );
      }
    }

    const { execution, ...patch } = input;
    if (execution !== undefined) {
      if (execution === null) deleteSetting(db, executionKey(channelId));
      else
        setSetting(db, executionKey(channelId), {
          ...conversationExecution(db, channelId),
          ...execution,
        });
      appendAudit(db, "channel.permissions_changed", null, { channelId, execution });
      revokeExecution?.(channelId);
    }
    const channel = updateChannel(db, channelId, patch);
    if (!channel) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Channel not found.", { requestId: request.id }));
    }

    return { channel: serialize(channel) };
  });

  app.delete("/api/channels/:channelId", async (request, reply) => {
    const { channelId } = request.params as { channelId: string };

    if (!getChannel(db, channelId)) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Channel not found.", { requestId: request.id }));
    }

    archiveChannel(db, channelId);
    return reply.code(204).send();
  });
}
