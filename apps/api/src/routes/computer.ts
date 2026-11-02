import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getRun,
  getComputerArtifact,
  listComputerArtifacts,
  deleteComputerArtifacts,
  appendAudit,
  type VektorDatabase,
} from "@vektor/db";
import { computerInputSchema } from "@vektor/shared";
import type { RunManager } from "../runs/run-manager.js";
import { RuntimeError } from "../runtime/terminal.js";

export function registerComputerRoutes(
  app: FastifyInstance,
  db: VektorDatabase,
  manager: RunManager,
) {
  app.get("/api/computer/capabilities", async () => manager.computerCapabilities());
  const run = (id: string) => {
    if (!getRun(db, id)) throw new RuntimeError("Run not found.", 404);
  };
  app.get("/api/runs/:runId/computer", async (request) => {
    const { runId } = request.params as { runId: string };
    run(runId);
    return {
      session: manager.computerState(runId),
      artifacts: listComputerArtifacts(db, runId).map((file) => ({
        ...file,
        createdAt: file.createdAt.toISOString(),
        expiresAt: file.expiresAt.toISOString(),
      })),
    };
  });
  app.get("/api/runs/:runId/computer/screenshot", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    run(runId);
    const jpeg = await manager.computerScreenshot(runId);
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type("image/jpeg")
      .send(jpeg);
  });
  app.post("/api/runs/:runId/computer/control", async (request) => {
    const { runId } = request.params as { runId: string };
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "close", "private"]) })
      .strict()
      .parse(request.body);
    await manager.computerControl(runId, action);
    return { ok: true };
  });
  app.post("/api/runs/:runId/computer/input", async (request) => {
    const { runId } = request.params as { runId: string };
    return manager.computerTakeover(runId, computerInputSchema.parse(request.body));
  });
  app.get("/api/computer-artifacts/:artifactId", async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    const artifact = getComputerArtifact(db, artifactId);
    if (!artifact) throw new RuntimeError("Computer artifact expired or was deleted.", 404);
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type("image/jpeg")
      .send(Buffer.from(artifact.jpeg, "base64"));
  });
  app.delete("/api/runs/:runId/computer/artifacts", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    run(runId);
    deleteComputerArtifacts(db, runId);
    appendAudit(db, "computer.artifacts_deleted", runId);
    return reply.code(204).send();
  });
}
