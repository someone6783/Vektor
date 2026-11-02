import { afterEach, describe, it, expect, vi } from "vitest";
import { getRun, listApprovals, listToolCalls } from "@vektor/db";
import { harness } from "./fixtures.test-utils.js";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
describe("scheduled MCP declarations", () => {
  it("requires both a scheduled profile grant and an explicit job declaration", async () => {
    const h = await harness();
    close = h.close;
    const server = await h.ready();
    const input = {
      name: "MCP job",
      schedule: "0 9 * * *",
      timezone: "UTC",
      profileId: h.profileId,
      channelId: h.channelId,
      prompt: "CALL echo",
      enabled: false,
      mcpServers: [server.id],
    };
    const denied = await h.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: h.headers,
      payload: input,
    });
    expect(denied.statusCode).toBe(403);
    await h.api(
      `/api/mcp/profiles/${h.profileId}/servers/${server.id}`,
      { tools: [{ name: "echo", policy: "read-only" }], scheduled: true },
      "PUT",
    );
    const noDeclaration = (await h.api("/api/jobs", { ...input, mcpServers: [] })).job;
    const ungranted = (await h.api(`/api/jobs/${noDeclaration.id}/run`, {})).execution;
    await h.completed(ungranted.runId);
    expect(listApprovals(h.storage.db, ungranted.runId)).toHaveLength(0);
    expect(listToolCalls(h.storage.db, ungranted.runId)[0]?.status).toBe("denied");
    const job = (await h.api("/api/jobs", input)).job;
    const execution = (await h.api(`/api/jobs/${job.id}/run`, {})).execution;
    await h.pending(execution.runId);
    expect((await h.api(`/api/jobs/${job.id}/runs`)).executions[0].awaitingApproval).toBe(true);
    await h.approve(execution.runId);
    await h.completed(execution.runId);
    expect((await h.api(`/api/jobs/${job.id}/runs`)).executions[0].status).toBe("completed");
  }, 25_000);
  it("cancels a pending scheduled call when its MCP declaration is revoked", async () => {
    const h = await harness();
    close = h.close;
    const server = await h.ready({}, { scheduled: true });
    const job = (
      await h.api("/api/jobs", {
        name: "Revoke MCP",
        schedule: "0 9 * * *",
        timezone: "UTC",
        profileId: h.profileId,
        channelId: h.channelId,
        prompt: "CALL wait",
        enabled: false,
        mcpServers: [server.id],
      })
    ).job;
    const execution = (await h.api(`/api/jobs/${job.id}/run`, {})).execution;
    await h.pending(execution.runId);
    await h.api(`/api/jobs/${job.id}`, { mcpServers: [] }, "PATCH");
    await vi.waitFor(() => expect(getRun(h.storage.db, execution.runId)?.status).toBe("cancelled"));
    expect(listApprovals(h.storage.db, execution.runId)[0]?.status).toBe("cancelled");
  }, 20_000);
});
