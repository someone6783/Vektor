import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { updatePreferencesSchema } from "@vektor/shared";
import { dockerUpdateState, queueDockerUpdate } from "../updates/install.js";
import { RuntimeError } from "../runtime/terminal.js";
import type { UpdateService } from "../updates/service.js";

export function registerUpdateRoutes(
  app: FastifyInstance,
  updates: UpdateService,
  stopForUpdate?: () => Promise<void>,
) {
  app.get("/api/update-install", async () => dockerUpdateState());
  app.post("/api/update-install", async (request, reply) => {
    z.object({}).strict().parse(request.body);
    const latest = await updates.check(true);
    if (!latest.updateAvailable || !latest.latestVersion)
      throw new RuntimeError("No newer stable release is available.", 409);
    if (!(await dockerUpdateState()).configured)
      throw new RuntimeError("Docker host updater is unavailable.", 503);
    await stopForUpdate?.();
    return reply.code(202).send(await queueDockerUpdate(latest.latestVersion));
  });
  app.get("/api/update-check", async (request) => {
    const { force } = z
      .object({ force: z.enum(["true", "false"]).optional() })
      .strict()
      .parse(request.query);
    return updates.check(force === "true");
  });
  app.put("/api/update-check", async (request) =>
    updates.configure(updatePreferencesSchema.parse(request.body)),
  );
}
