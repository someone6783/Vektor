import type { FastifyInstance } from "fastify";
import {
  archiveProfile,
  createProfile,
  getProfile,
  listProfiles,
  updateProfile,
  type VektorDatabase,
} from "@vektor/db";
import { createProfileSchema, makeApiError, updateProfileSchema } from "@vektor/shared";
import { toProfile } from "../serializers.js";

export function registerProfileRoutes(app: FastifyInstance, db: VektorDatabase): void {
  app.get("/api/profiles", async () => ({
    profiles: listProfiles(db).map(toProfile),
  }));

  app.post("/api/profiles", async (request, reply) => {
    const input = createProfileSchema.parse(request.body);
    const profile = createProfile(db, input);
    return reply.code(201).send({ profile: toProfile(profile) });
  });

  app.patch("/api/profiles/:profileId", async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const input = updateProfileSchema.parse(request.body);

    const existing = getProfile(db, profileId);
    if (!existing) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Profile not found.", { requestId: request.id }));
    }

    if (input.archived === true && listProfiles(db).length <= 1) {
      return reply.code(409).send(
        makeApiError("last_profile", "At least one active profile is required.", {
          requestId: request.id,
        }),
      );
    }

    const profile = updateProfile(db, profileId, input);
    if (!profile) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Profile not found.", { requestId: request.id }));
    }

    return { profile: toProfile(profile) };
  });

  app.delete("/api/profiles/:profileId", async (request, reply) => {
    const { profileId } = request.params as { profileId: string };

    if (!getProfile(db, profileId)) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Profile not found.", { requestId: request.id }));
    }

    if (listProfiles(db).length <= 1) {
      return reply.code(409).send(
        makeApiError("last_profile", "At least one active profile is required.", {
          requestId: request.id,
        }),
      );
    }

    archiveProfile(db, profileId);
    return reply.code(204).send();
  });
}
