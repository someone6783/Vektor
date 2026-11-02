import type { FastifyInstance } from "fastify";
import { getProfile } from "@vektor/db";
import { z } from "zod";
import { mcpGrantSchema, mcpIdSchema, mcpServerInputSchema } from "@vektor/shared";
import type { McpService } from "../mcp/service.js";
import { secretInputSchema } from "../mcp/store.js";
import type { RunManager } from "../runs/run-manager.js";
import { RuntimeError } from "../runtime/terminal.js";

export function registerMcpRoutes(
  app: FastifyInstance,
  mcp: McpService,
  manager: RunManager,
): void {
  const idOf = (params: unknown) => z.object({ id: mcpIdSchema }).parse(params).id;
  app.get("/api/mcp", async () => ({ servers: mcp.store.list(), grants: mcp.store.grants() }));
  app.post("/api/mcp/servers", async (request, reply) => {
    manager.assertCanStart();
    mcp.assertSafeConfiguration(request.body);
    return reply
      .code(201)
      .send({ server: mcp.store.configure(mcpServerInputSchema.parse(request.body)) });
  });
  app.put("/api/mcp/servers/:id", async (request) => {
    manager.assertCanStart();
    const id = idOf(request.params);
    const input = mcpServerInputSchema.parse(request.body);
    mcp.assertSafeConfiguration(input);
    await manager.revokeMcp({ serverId: id });
    await mcp.content.removeServer(id);
    return { server: mcp.store.configure(input, id) };
  });
  app.delete("/api/mcp/servers/:id", async (request, reply) => {
    const id = idOf(request.params);
    await manager.revokeMcp({ serverId: id });
    await mcp.content.removeServer(id);
    mcp.store.remove(id);
    return reply.code(204).send();
  });
  app.put("/api/mcp/servers/:id/credentials", async (request) => {
    const id = idOf(request.params),
      { values } = secretInputSchema.parse(request.body);
    await manager.revokeMcp({ serverId: id });
    mcp.store.setCredentials(id, values);
    return { configuredNames: Object.keys(values) };
  });
  app.post("/api/mcp/servers/:id/test", async (request) => {
    manager.assertCanStart();
    const id = idOf(request.params);
    await manager.revokeMcp({ serverId: id });
    return { server: await mcp.test(id) };
  });
  app.patch("/api/mcp/servers/:id", async (request) => {
    const id = idOf(request.params),
      { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    if (enabled) manager.assertCanStart();
    else await manager.revokeMcp({ serverId: id });
    return { server: mcp.store.enable(id, enabled) };
  });
  app.put("/api/mcp/profiles/:profileId/servers/:id", async (request) => {
    const { profileId, id } = z
      .object({ profileId: z.string(), id: mcpIdSchema })
      .parse(request.params);
    if (!getProfile(mcp.db, profileId)) throw new RuntimeError("Profile not found.", 404);
    const grant = mcpGrantSchema.parse(request.body);
    await manager.revokeMcp({ profileId, serverId: id });
    mcp.store.setGrant(profileId, id, grant);
    return { grant };
  });
  app.post("/api/mcp/context/preview", async (request) => {
    manager.assertCanStart();
    const input = z
      .object({
        profileId: z.string(),
        serverId: mcpIdSchema,
        kind: z.enum(["resource", "template", "prompt"]),
        name: z.string().min(1).max(2000),
        arguments: z
          .record(z.string().max(10000))
          .refine((v) => Object.keys(v).length <= 30)
          .default({}),
      })
      .strict()
      .parse(request.body);
    const context = await mcp.preview(
      input.profileId,
      input.serverId,
      input.kind,
      input.name,
      input.arguments,
    );
    return { context, text: await mcp.content.read("contexts", context.id) };
  });
  app.get("/api/mcp/context", async (request) => {
    const { profileId } = z.object({ profileId: z.string() }).parse(request.query);
    return { contexts: mcp.contexts(profileId) };
  });
  app.get("/api/mcp/context/:id", async (request) => {
    const id = idOf(request.params),
      item = mcp.content.list().find((c) => c.id === id);
    if (!item) throw new RuntimeError("MCP context not found.", 404);
    await mcp.selectedContext(item.profileId, [id]);
    return { text: await mcp.content.read("contexts", id) };
  });
  app.delete("/api/mcp/context/:id", async (request, reply) => {
    await mcp.content.remove("contexts", idOf(request.params));
    return reply.code(204).send();
  });
  app.get("/api/mcp/artifacts/:id", async (request) =>
    JSON.parse(await mcp.content.read("artifacts", idOf(request.params))),
  );
  app.delete("/api/mcp/artifacts/:id", async (request, reply) => {
    await mcp.content.remove("artifacts", idOf(request.params));
    return reply.code(204).send();
  });
}
