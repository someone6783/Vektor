import { discoverNativeRunners, readNativeAccount } from "../runners/native.js";
import type { FastifyInstance } from "fastify";
import { getProfile, listProfiles, type VektorDatabase } from "@vektor/db";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join } from "node:path";
import {
  configureRunnerSchema,
  grantSchema,
  type RunnerInstallations,
} from "../runners/installations.js";
import type { ExternalRunners } from "../runners/service.js";
import type { RunManager } from "../runs/run-manager.js";
import { z } from "zod";
import { type RunnerSetup, probeInputSchema } from "../runners/setup.js";
import { RuntimeError } from "../runtime/terminal.js";

export function registerRunnerRoutes(
  app: FastifyInstance,
  db: VektorDatabase,
  setup: RunnerSetup,
  installations: RunnerInstallations,
  external: ExternalRunners,
  manager: RunManager,
): void {
  const catalog = installations.catalog;
  let configuring = false;
  app.get("/api/runners", async () => ({
    probes: setup.results(),
    registry: catalog.snapshot(),
    installations: installations.list().map((entry) => ({
      ...entry,
      ...installations.compatibility(entry),
      health: installations.health(entry.id),
      credentialConfigured: !!installations.credential(entry.id),
      authKind: entry.authKind ?? "separate-api-key",
      billing: "agent account/provider; separate from OpenRouter",
    })),
    grants: listProfiles(db).map((profile) => ({
      profileId: profile.id,
      ...installations.grant(profile.id),
    })),
  }));
  app.get("/api/runners/discover", async () => {
    const names = new Set([
      "codex",
      "opencode",
      ...(catalog
        .snapshot()
        ?.agents.flatMap((agent) =>
          Object.values(agent.distribution.binary ?? {}).map((target) => basename(target.cmd)),
        ) ?? []),
    ]);
    const found: Array<{ name: string; command: string }> = await discoverNativeRunners();
    for (const name of names) {
      if (found.some((entry) => entry.name === name)) continue;
      if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === "." || name === "..") continue;
      for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
        if (!directory.startsWith("/")) continue;
        const command = join(directory, name);
        try {
          await access(command, constants.X_OK);
          if (!(await stat(command)).isFile()) continue;
          found.push({ name, command });
          break;
        } catch {
          /* Not installed here. */
        }
      }
    }
    return { executables: found };
  });
  app.post("/api/runners/connect", async (request) => {
    manager.assertCanStart();
    const { runner } = z
      .object({ runner: z.enum(["codex", "opencode"]) })
      .strict()
      .parse(request.body);
    if (configuring) throw new RuntimeError("Another agent verification is active.", 409);
    configuring = true;
    try {
      const executable = (await discoverNativeRunners()).find((entry) => entry.name === runner);
      if (!executable)
        throw new RuntimeError(
          `Install ${runner === "codex" ? "Codex" : "OpenCode"} on the backend machine, then connect again.`,
          409,
        );
      const account = await readNativeAccount(runner);
      const probe = await setup.probe({
        interface: runner === "codex" ? "codex-app-server" : "acp-v1",
        command: executable.command,
        args: runner === "codex" ? [] : ["acp"],
      });
      if (runner === "opencode") await catalog.sync();
      manager.assertCanStart();
      const id = runner === "codex" ? "codex" : "acp:opencode";
      await manager.revokeExternalRunner(id);
      const entry = await installations.configure(
        {
          id,
          executableHash: probe.executableHash,
          ...(runner === "codex" ? { trustLocalCodex: true as const } : {}),
          inferenceHosts: account.hosts,
          credentialName: "OPENAI_API_KEY",
          authKind: "native-account",
        },
        setup.results(),
      );
      manager.assertCanStart();
      installations.setCredential(entry.id, JSON.stringify(account));
      installations.enable(entry.id, true);
      return { connected: true };
    } finally {
      configuring = false;
    }
  });
  app.post("/api/runners/installations", async (request, reply) => {
    manager.assertCanStart();
    const input = configureRunnerSchema.parse(request.body);
    if (configuring) throw new RuntimeError("Another agent verification is active.", 409);
    configuring = true;
    try {
      const entry = await installations.configure(input, setup.results());
      await manager.revokeExternalRunner(entry.id);
      return reply.code(201).send({ installation: entry });
    } finally {
      configuring = false;
    }
  });
  app.patch("/api/runners/installations/:id", async (request) => {
    const { id } = request.params as { id: string };
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    if (enabled) manager.assertCanStart();
    const entry = installations.enable(id, enabled);
    if (!enabled) await manager.revokeExternalRunner(id);
    return { installation: entry };
  });
  app.delete("/api/runners/installations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await manager.revokeExternalRunner(id);
    await installations.remove(id);
    return reply.code(204).send();
  });
  app.put("/api/runners/installations/:id/credential", async (request) => {
    const { id } = request.params as { id: string };
    const { key } = z
      .object({ key: z.string().min(8).max(16_000).nullable() })
      .strict()
      .parse(request.body);
    await manager.revokeExternalRunner(id);
    installations.setCredential(id, key);
    return { configured: key !== null };
  });
  app.put("/api/profiles/:id/runner-grant", async (request) => {
    const { id } = request.params as { id: string };
    const profile = getProfile(db, id);
    if (!profile) throw new RuntimeError("Profile not found.", 404);
    const input = grantSchema.parse(request.body);
    const runner = input.runner ?? profile.runner ?? "native";
    if (runner === "native" || runner === "cli")
      throw new RuntimeError("Select the external agent this profile grant applies to.", 409);
    const grant = { ...input, runner };
    await manager.revokeExternal(id);
    installations.setGrant(id, grant);
    return { grant };
  });
  app.delete("/api/runs/:runId/runner-checkpoint", async (request, reply) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    await external.snapshots.remove(runId);
    return reply.code(204).send();
  });
  app.post("/api/runners/registry/sync", async () => {
    try {
      return await catalog.sync();
    } catch {
      throw new RuntimeError(
        "Official registry refresh failed. The last valid snapshot is retained.",
        502,
      );
    }
  });
  app.post("/api/runners/probe", async (request) => {
    try {
      return await setup.probe(probeInputSchema.parse(request.body));
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "Runner probe failed. Check the executable and protocol version; no execution was enabled.",
        409,
      );
    }
  });
  app.delete("/api/runners/probes/:hash", async (request, reply) => {
    const { hash } = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.params);
    setup.remove(hash);
    return reply.code(204).send();
  });
}
