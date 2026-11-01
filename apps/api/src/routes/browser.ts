import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getRun,
  getBrowserArtifact,
  listBrowserArtifacts,
  deleteBrowserArtifacts,
  appendAudit,
  type VektorDatabase,
} from "@vektor/db";
import { browserInputSchema } from "@vektor/shared";
import type { RunManager } from "../runs/run-manager.js";
import { RuntimeError } from "../runtime/terminal.js";

export function registerBrowserRoutes(
  app: FastifyInstance,
  db: VektorDatabase,
  manager: RunManager,
) {
  const run = (id: string) => {
    if (!getRun(db, id)) throw new RuntimeError("Run not found.", 404);
  };
  app.get("/api/runs/:runId/browser", async (request) => {
    const { runId } = request.params as { runId: string };
    run(runId);
    return {
      session: manager.browserState(runId),
      artifacts: listBrowserArtifacts(db, runId).map((file) => ({
        ...file,
        createdAt: file.createdAt.toISOString(),
        expiresAt: file.expiresAt.toISOString(),
      })),
    };
  });
  app.post("/api/runs/:runId/browser/control", async (request) => {
    const { runId } = request.params as { runId: string };
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "close"]) })
      .strict()
      .parse(request.body);
    await manager.browserControl(runId, action);
    return { ok: true };
  });
  app.post("/api/runs/:runId/browser/input", async (request) => {
    const { runId } = request.params as { runId: string };
    return manager.browserTakeover(runId, browserInputSchema.parse(request.body));
  });
  app.get("/api/browser-artifacts/:artifactId", async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    const artifact = getBrowserArtifact(db, artifactId);
    if (!artifact) throw new RuntimeError("Browser artifact expired or was deleted.", 404);
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type("image/jpeg")
      .send(Buffer.from(artifact.jpeg, "base64"));
  });
  app.delete("/api/runs/:runId/browser/artifacts", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    run(runId);
    deleteBrowserArtifacts(db, runId);
    appendAudit(db, "browser.artifacts_deleted", runId);
    return reply.code(204).send();
  });
}
