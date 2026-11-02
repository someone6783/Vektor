import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { RuntimeError } from "../runtime/terminal.js";

export const workspaceReadSchema = z
  .object({
    path: z.string().min(1).max(2000),
    line: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  })
  .strict();
export const workspaceProposalSchema = z
  .object({
    path: z.string().min(1).max(2000),
    content: z
      .string()
      .max(256 * 1024)
      .optional(),
    before: z
      .string()
      .max(256 * 1024)
      .optional(),
    previousHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
export const workspaceWriteSchema = z
  .object({ path: z.string().min(1).max(2000), content: z.string().max(256 * 1024) })
  .strict();
export class RunnerWorkspace {
  constructor(private readonly root: string) {}
  private async path(value: string, missing: boolean): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new RuntimeError("Runner workspace cannot be a symlink.", 403);
    const root = await realpath(this.root);
    const input = value.startsWith("/workspace/") ? value.slice(11) : value;
    if (isAbsolute(input) || input.includes("\0"))
      throw new RuntimeError("Runner files must stay inside /workspace.", 403);
    const path = resolve(root, input);
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new RuntimeError("Runner file path is outside the workspace.", 403);
    let current = root;
    const parts = rel.split(sep);
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      try {
        const entry = await lstat(current);
        if (
          entry.isSymbolicLink() ||
          (!entry.isDirectory() && !entry.isFile()) ||
          (entry.isFile() && entry.nlink !== 1)
        )
          throw new RuntimeError("Runner files cannot follow links or special files.", 403);
        if (index < parts.length - 1 && !entry.isDirectory())
          throw new RuntimeError("Invalid parent directory.", 403);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !missing) throw error;
        // The write method creates parents only after human approval.
        break;
      }
    }
    return path;
  }
  private async readAll(value: string): Promise<string> {
    const path = await this.path(value, false);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = await file.stat();
      if (!entry.isFile() || entry.nlink !== 1 || entry.size > 256 * 1024)
        throw new RuntimeError("Runner file exceeds its text limit.", 413);
      const bytes = await file.readFile();
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new RuntimeError("Runner files must contain UTF-8 text.", 415);
      }
    } finally {
      await file.close();
    }
  }
  async fingerprint(value: string): Promise<string | null> {
    try {
      return createHash("sha256")
        .update(await this.readAll(value))
        .digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async stage(redact: (value: string) => string): Promise<WorkspaceStage> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new RuntimeError("Runner workspace cannot be a symlink.", 403);
    const directory = await mkdtemp("/dev/shm/vektor-stage-");
    const baseline = new Map<string, string>();
    let bytes = 0;
    let files = 0;
    const visit = async (relativePath: string, depth: number) => {
      if (depth > 20)
        throw new RuntimeError("Workspace directory depth exceeds the runner snapshot limit.", 413);
      for (const entry of await readdir(join(this.root, relativePath), { withFileTypes: true })) {
        if (
          [".git", "node_modules", ".env", ".npmrc", ".netrc"].includes(entry.name) ||
          entry.name.startsWith(".env.")
        )
          continue;
        const path = join(relativePath, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await visit(path, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        let content: string;
        try {
          content = await this.readAll(path);
        } catch (error) {
          if (error instanceof RuntimeError && [413, 415].includes(error.statusCode)) continue;
          throw error;
        }
        if (content.includes("\0") || redact(content) !== content) continue;
        bytes += Buffer.byteLength(content);
        files++;
        if (bytes > 32 * 1024 * 1024 || files > 1000)
          throw new RuntimeError(
            "Workspace snapshot exceeds 32 MiB or 1,000 text files. Use a smaller workspace.",
            413,
          );
        baseline.set(path, createHash("sha256").update(content).digest("hex"));
        const target = join(directory, path);
        await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600 });
      }
    };
    try {
      await visit("", 0);
      return { directory, baseline };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async syncStage(
    stage: WorkspaceStage,
    value: string,
    redact: (value: string) => string,
  ): Promise<void> {
    const path = relative(await realpath(this.root), await this.path(value, false));
    const content = await this.readAll(value);
    if (redact(content) !== content)
      throw new RuntimeError("Credential-bearing files are excluded from agent snapshots.", 403);
    await new RunnerWorkspace(stage.directory).write(
      { path, content },
      async () => true,
      new AbortController().signal,
    );
    stage.baseline.set(path, createHash("sha256").update(content).digest("hex"));
  }
  async stageChanges(
    stage: WorkspaceStage,
  ): Promise<Array<{ path: string; content?: string; previousHash: string | null }>> {
    const remaining = new Map(stage.baseline);
    const changes: Array<{ path: string; content?: string; previousHash: string | null }> = [];
    const staged = new RunnerWorkspace(stage.directory);
    let count = 0;
    let bytes = 0;
    const visit = async (relativePath: string, depth: number) => {
      if (depth > 20) throw new RuntimeError("Agent stage exceeds directory depth limit.", 413);
      for (const entry of await readdir(join(stage.directory, relativePath), {
        withFileTypes: true,
      })) {
        const path = join(relativePath, entry.name);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
          throw new RuntimeError("Agent stages cannot contain links or special files.", 403);
        if (entry.isDirectory()) {
          await visit(path, depth + 1);
          continue;
        }
        const content = await staged.readAll(path);
        count++;
        bytes += Buffer.byteLength(content);
        if (count > 1000 || bytes > 32 * 1024 * 1024)
          throw new RuntimeError("Agent stage exceeds workspace limits.", 413);
        const previousHash = stage.baseline.get(path) ?? null;
        if (createHash("sha256").update(content).digest("hex") !== previousHash)
          changes.push({ path, content, previousHash });
        remaining.delete(path);
      }
    };
    await visit("", 0);
    for (const [path, previousHash] of remaining) changes.push({ path, previousHash });
    return changes;
  }
  async remove(
    value: string,
    previousHash: string,
    approve: () => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<string> {
    if ((await this.fingerprint(value)) !== previousHash)
      throw new RuntimeError(
        "File changed since the agent snapshot. Review a fresh proposal.",
        409,
      );
    if (!(await approve())) throw new RuntimeError("The user denied this deletion.", 403);
    signal.throwIfAborted();
    if ((await this.fingerprint(value)) !== previousHash)
      throw new RuntimeError("File changed while approval was pending.", 409);
    await rm(await this.path(value, false));
    return "File deletion applied.";
  }
  async read(input: z.infer<typeof workspaceReadSchema>): Promise<string> {
    const path = await this.path(input.path, false);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = await file.stat();
      if (!entry.isFile() || entry.nlink !== 1 || entry.size > 256 * 1024)
        throw new RuntimeError("Runner file exceeds its text limit.", 413);
      const content = await file.readFile("utf8");
      return content
        .split("\n")
        .slice((input.line ?? 1) - 1, (input.line ?? 1) - 1 + (input.limit ?? 2000))
        .join("\n");
    } finally {
      await file.close();
    }
  }
  async write(
    input: z.infer<typeof workspaceWriteSchema>,
    approve: () => Promise<boolean>,
    signal: AbortSignal,
    previousHash?: string | null,
  ): Promise<string> {
    await this.path(input.path, true);
    if (previousHash !== undefined && (await this.fingerprint(input.path)) !== previousHash)
      throw new RuntimeError(
        "File changed since the agent snapshot. Review a fresh proposal.",
        409,
      );
    if (!(await approve())) throw new RuntimeError("The user denied this file change.", 403);
    signal.throwIfAborted();
    if (previousHash !== undefined && (await this.fingerprint(input.path)) !== previousHash)
      throw new RuntimeError("File changed while approval was pending.", 409);
    const path = await this.path(input.path, true);
    const root = await realpath(this.root);
    const parts = relative(root, path).split(sep);
    parts.pop();
    let parent = root;
    for (const part of parts) {
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!(await lstat(parent)).isDirectory() || (await lstat(parent)).isSymbolicLink())
        throw new RuntimeError("Invalid runner file parent.", 403);
    }
    await this.path(input.path, true);
    signal.throwIfAborted();
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const entry = await file.stat();
      if (!entry.isFile() || entry.nlink !== 1)
        throw new RuntimeError("Runner cannot write this file.", 403);
      await file.truncate(0);
      await file.writeFile(input.content, "utf8");
    } finally {
      await file.close();
    }
    return "File change applied.";
  }
}

export interface WorkspaceStage {
  directory: string;
  baseline: Map<string, string>;
}
