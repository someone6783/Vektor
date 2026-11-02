import { createHash } from "node:crypto";
import { z } from "zod";
import { getSetting, setSetting, appendAudit, type VektorDatabase } from "@vektor/db";

export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const text = z.string().min(1).max(2000);
const https = text.url().refine((url) => new URL(url).protocol === "https:");
const distribution = z.object({
  npx: z.object({ package: text, args: z.array(text).max(50).optional() }).optional(),
  uvx: z.object({ package: text, args: z.array(text).max(50).optional() }).optional(),
  binary: z
    .record(
      z.object({
        archive: https,
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        cmd: text,
        args: z.array(text).max(50).optional(),
        env: z.record(text).optional(),
      }),
    )
    .optional(),
});
export const registryEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  name: text,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: text,
  repository: https.optional(),
  website: https.optional(),
  authors: z.array(text).max(50),
  license: text,
  license_url: https.optional(),
  distribution,
});
const registrySchema = z
  .object({ version: z.literal("1.0.0"), agents: z.array(registryEntrySchema).max(500) })
  .superRefine((registry, ctx) => {
    const ids = new Set<string>();
    for (const agent of registry.agents) {
      if (ids.has(agent.id)) ctx.addIssue({ code: "custom", message: "Duplicate agent identity" });
      ids.add(agent.id);
      if (!Object.values(agent.distribution).some(Boolean))
        ctx.addIssue({ code: "custom", message: "Missing distribution" });
    }
  });
export type RegistryEntry = z.infer<typeof registryEntrySchema>;
export interface RegistrySnapshot {
  source: string;
  checkedAt: string;
  hash: string;
  agents: RegistryEntry[];
}
export function parseRegistry(value: unknown): RegistryEntry[] {
  return registrySchema.parse(value).agents;
}

export class AgentCatalog {
  private syncing?: Promise<RegistrySnapshot>;
  constructor(
    private readonly db: VektorDatabase,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  snapshot(): RegistrySnapshot | null {
    const value = getSetting(this.db, "runner.registry.snapshot");
    if (!value || typeof value !== "object") return null;
    const result = z
      .object({
        source: z.literal(REGISTRY_URL),
        checkedAt: z.string().datetime(),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        agents: z.array(registryEntrySchema),
      })
      .safeParse(value);
    return result.success ? result.data : null;
  }
  sync(): Promise<RegistrySnapshot> {
    if (this.syncing) return this.syncing;
    this.syncing = this.fetchSnapshot().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }
  private async fetchSnapshot(): Promise<RegistrySnapshot> {
    const response = await this.fetcher(REGISTRY_URL, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok || !response.body) throw new Error("Official ACP registry is unavailable.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 2 * 1024 * 1024) throw new Error("ACP registry exceeds size limit.");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const agents = parseRegistry(JSON.parse(raw));
    const snapshot = {
      source: REGISTRY_URL,
      checkedAt: new Date().toISOString(),
      hash: createHash("sha256").update(raw).digest("hex"),
      agents,
    };
    setSetting(this.db, "runner.registry.snapshot", snapshot);
    appendAudit(this.db, "runner.registry_synced", null, {
      source: REGISTRY_URL,
      hash: snapshot.hash,
      entries: agents.length,
    });
    return snapshot;
  }
}
