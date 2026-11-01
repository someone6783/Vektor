import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { updatePreferencesSchema } from "@vektor/shared";
import type { UpdateService } from "../updates/service.js";

export function registerUpdateRoutes(app: FastifyInstance, updates: UpdateService) {
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
