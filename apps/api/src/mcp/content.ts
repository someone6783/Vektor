import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { getSetting, setSetting, type VektorDatabase } from "@vektor/db";
import { mcpContextSchema, mcpIdSchema, type McpContext } from "@vektor/shared";
import { encryptSecret, decryptSecret } from "../secrets.js";
import { RuntimeError } from "../runtime/terminal.js";

export class McpContent {
  private readonly directory: string;
  constructor(
    private readonly db: VektorDatabase,
    dataDir: string,
    private readonly key: Buffer,
  ) {
    this.directory = join(dataDir, "mcp");
  }
  private path(kind: "contexts" | "artifacts", id: string) {
    return join(this.directory, kind, `${mcpIdSchema.parse(id)}.enc`);
  }
  async write(kind: "contexts" | "artifacts", id: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > (kind === "artifacts" ? 300 : 128) * 1024)
      throw new RuntimeError("MCP stored content exceeds its size limit.", 413);
    const directory = join(this.directory, kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(this.path(kind, id), encryptSecret(content, this.key), {
      mode: 0o600,
      flag: "wx",
    });
    const files = await Promise.all(
      (await readdir(directory))
        .filter((n) => /^[a-f0-9-]{36}\.enc$/.test(n))
        .map(async (name) => ({ name, time: (await stat(join(directory, name))).mtimeMs })),
    );
    files.sort((a, b) => b.time - a.time);
    for (const file of files.filter((f, i) => i >= 100 || f.time < Date.now() - 7 * 86400_000))
      await rm(join(directory, file.name), { force: true });
  }
  async read(kind: "contexts" | "artifacts", id: string): Promise<string> {
    try {
      const path = this.path(kind, id),
        info = await stat(path);
      if (info.size > 512 * 1024 || info.mtimeMs < Date.now() - 7 * 86400_000)
        throw new Error("expired");
      return decryptSecret(await readFile(path, "utf8"), this.key);
    } catch {
      throw new RuntimeError("MCP content is unavailable or expired. Prepare it again.", 404);
    }
  }
  async remove(kind: "contexts" | "artifacts", id: string) {
    await rm(this.path(kind, id), { force: true });
    if (kind === "contexts")
      setSetting(
        this.db,
        "mcp.contexts",
        this.list().filter((c) => c.id !== id),
      );
  }
  list(): McpContext[] {
    return z.array(mcpContextSchema).parse(getSetting(this.db, "mcp.contexts") ?? []);
  }
  async saveContext(
    meta: Omit<McpContext, "id" | "preview" | "size" | "createdAt">,
    text: string,
  ): Promise<McpContext> {
    if (Buffer.byteLength(text) > 32 * 1024)
      throw new RuntimeError("Selected MCP context exceeds 32 KiB.", 413);
    const context = {
      ...meta,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      preview: text.slice(0, 240),
      size: Buffer.byteLength(text),
    };
    await this.write("contexts", context.id, text);
    setSetting(this.db, "mcp.contexts", [...this.list().slice(-99), context]);
    return context;
  }
  async artifact(runId: string, text: string): Promise<string> {
    const id = randomUUID();
    await this.write("artifacts", id, JSON.stringify({ runId, text }));
    return id;
  }
  async removeServer(id: string) {
    for (const context of this.list().filter((c) => c.serverId === id))
      await this.remove("contexts", context.id);
  }
}
