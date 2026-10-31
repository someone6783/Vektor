import type { FastifyInstance } from "fastify";
import {
  archiveChannel,
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

export function registerChannelRoutes(app: FastifyInstance, db: VektorDatabase): void {
  app.get("/api/channels", async (request) => {
    const query = request.query as { includeArchived?: string };
    return {
      channels: listChannels(db, { includeArchived: includeArchived(query.includeArchived) }).map(
        toChannel,
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

    return reply.code(201).send({ channel: toChannel(channel) });
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

    const channel = updateChannel(db, channelId, input);
    if (!channel) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Channel not found.", { requestId: request.id }));
    }

    return { channel: toChannel(channel) };
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
