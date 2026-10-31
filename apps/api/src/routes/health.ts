import type { FastifyInstance } from "fastify";
import { healthResponseSchema, type HealthResponse } from "@vektor/shared";
import type { Storage } from "../bootstrap.js";
import { VERSION } from "../config.js";

export function registerHealthRoutes(app: FastifyInstance, storage: Storage): void {
  app.get("/healthz", async (request, reply) => {
    let database: HealthResponse["database"] = "ok";

    try {
      storage.sqlite.prepare("select 1").get();
    } catch (error) {
      database = "error";
      request.log.error({ err: error }, "database health check failed");
    }

    const body = healthResponseSchema.parse({
      status: database,
      version: VERSION,
      instanceId: storage.instanceId,
      database,
      uptimeSeconds: Math.max(0, Math.round(process.uptime())),
    });

    return reply.code(database === "ok" ? 200 : 503).send(body);
  });
}
