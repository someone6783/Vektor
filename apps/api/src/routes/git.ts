import { execFile } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  gitFileInputSchema,
  gitCommitInputSchema,
  gitPushInputSchema,
  gitStatusInputSchema,
  gitStatusSchema,
  type GitCode,
  type GitFileStatus,
  type GitStatus,
} from "@vektor/shared";
import { RuntimeError } from "../runtime/terminal.js";

const asyncExecFile = promisify(execFile);
const MAX_FILES = 500;

interface GitFailure extends Error {
  code?: string | number;
  killed?: boolean;
  stderr?: string;
}

function gitFailure(error: unknown): never {
  const failure = error as GitFailure;
  if (failure.code === "ENOENT")
    throw new RuntimeError("The git command is not available on this machine.", 500);
  if (failure.killed) throw new RuntimeError("The git command timed out.", 504);
  const detail = (failure.stderr ?? failure.message ?? "")
    .trim()
    .split("\n")
    .slice(-3)
    .join(" ")
    .trim();
  throw new RuntimeError(detail || "The git command failed.", 400);
}

/** Run git, throwing a client-facing RuntimeError on spawn and timeout failures. */
function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return gitRun(cwd, args, timeoutMs).then((run) => {
    if (run.code !== 0) {
      const detail = run.stderr.trim().split("\n").slice(-3).join(" ").trim();
      throw new RuntimeError(detail || "The git command failed.", 400);
    }
    return run.stdout;
  });
}

/** Run git and return the exit code so callers can branch on git's own signals. */
async function gitRun(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await asyncExecFile("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as GitFailure;
    if (failure.code === "ENOENT") return gitFailure(failure);
    if (failure.killed) return gitFailure(failure);
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
}

async function projectDirectory(value: string): Promise<string> {
  try {
    if ((await stat(value)).isDirectory()) return value;
  } catch {
    // Handled below.
  }
  throw new RuntimeError("Set the git panel to an existing project directory.", 400);
}

async function insideWorkTree(cwd: string): Promise<boolean> {
  const run = await gitRun(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return run.code === 0 && run.stdout.trim() === "true";
}

interface BranchSummary {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

function parseBranchLine(line: string): BranchSummary {
  const summary: BranchSummary = { branch: null, upstream: null, ahead: 0, behind: 0 };
  const header = line.replace(/^##\s*/, "");
  if (header.startsWith("No commits yet on ")) {
    summary.branch = header.slice("No commits yet on ".length).trim();
    return summary;
  }
  if (header.startsWith("HEAD (no branch)")) return summary;
  const info = header.match(/^([^.\s]+)(?:\.{3}([^[\]]+?))?(?:\s+\[([^\]]+)])?$/);
  if (!info) return summary;
  summary.branch = info[1] ?? null;
  summary.upstream = info[2]?.trim() ?? null;
  const markers = info[3];
  if (markers) {
    const ahead = markers.match(/ahead (\d+)/);
    const behind = markers.match(/behind (\d+)/);
    summary.ahead = ahead ? Number(ahead[1]) : 0;
    summary.behind = behind ? Number(behind[1]) : 0;
    if (markers.includes("gone")) summary.upstream = null;
  }
  return summary;
}

function parseStatus(raw: string): GitStatus {
  const records = raw.split("\0").filter((value) => value.length > 0);
  const files: GitFileStatus[] = [];
  let branch: BranchSummary = { branch: null, upstream: null, ahead: 0, behind: 0 };
  let filesTruncated = false;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("##")) {
      branch = parseBranchLine(record);
      continue;
    }
    const header = record.match(/^([ACDMRTU?! ])([ACDMRTU?! ]) (.*)$/);
    if (!header) continue;
    const path = header[3];
    if (path === undefined) continue;
    // `git status -z` emits the new name in this record and the previous name
    // in the following record for every rename or copy entry. Consume that
    // record explicitly so unusual filenames cannot be parsed as status entries.
    if (header[1] === "R" || header[1] === "C" || header[2] === "R" || header[2] === "C") i++;
    const index = header[1] as GitCode;
    const worktree = header[2] as GitCode;
    if (files.length < MAX_FILES) {
      files.push({
        path,
        index,
        worktree,
        untracked: index === "?" && worktree === "?",
      });
    } else filesTruncated = true;
  }
  return { repository: true, ...branch, files, filesTruncated, lastCommit: null };
}

async function lastCommit(cwd: string): Promise<GitStatus["lastCommit"]> {
  const run = await gitRun(cwd, ["log", "-1", "--pretty=format:%h%x1f%s%x1f%at"]);
  if (run.code !== 0) return null;
  const [hash = "", subject = "", time = ""] = run.stdout.trim().split("\x1f");
  if (!hash || !Number.isFinite(Number(time))) return null;
  return { hash, subject, time: new Date(Number(time) * 1000).toISOString() };
}

function emptyStatus(): GitStatus {
  return {
    repository: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    filesTruncated: false,
    lastCommit: null,
  };
}

function registerGitStatusRoutes(app: FastifyInstance): void {
  app.post("/api/git/status", async (request: FastifyRequest) => {
    const input = gitStatusInputSchema.parse(request.body);
    const project = await projectDirectory(input.path);
    if (!(await insideWorkTree(project))) return gitStatusSchema.parse(emptyStatus());
    const directory = (await git(project, ["rev-parse", "--show-toplevel"])).trim();
    const raw = await git(directory, [
      "status",
      "--porcelain=v1",
      "-z",
      "--branch",
      "--untracked-files=all",
    ]);
    const status = parseStatus(raw);
    status.lastCommit = await lastCommit(directory);
    return gitStatusSchema.parse(status);
  });
}

function registerGitCommitRoutes(app: FastifyInstance): void {
  app.post("/api/git/commit", async (request: FastifyRequest) => {
    const input = gitCommitInputSchema.parse(request.body);
    const directory = await projectDirectory(input.path);
    if (!(await insideWorkTree(directory)))
      throw new RuntimeError("Choose a git repository before committing.", 400);
    await git(directory, ["add", "--", ...input.files]);
    const staged = await gitRun(directory, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0)
      throw new RuntimeError("Nothing to commit — choose at least one change.", 400);
    if (staged.code > 1) throw new RuntimeError(staged.stderr.trim() || "Staging failed.", 400);
    await git(directory, ["commit", "-q", "-m", input.message], 120_000);
    const commit = (await git(directory, ["rev-parse", "--short", "HEAD"])).trim();
    const branch = (await git(directory, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return { ok: true, commit, branch: branch === "HEAD" ? null : branch };
  });
}

function registerGitPushRoutes(app: FastifyInstance): void {
  app.post("/api/git/push", async (request: FastifyRequest) => {
    const input = gitPushInputSchema.parse(request.body);
    const directory = await projectDirectory(input.path);
    if (!(await insideWorkTree(directory)))
      throw new RuntimeError("Choose a git repository before pushing.", 400);
    const branch = (await git(directory, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch === "HEAD") throw new RuntimeError("Cannot push from a detached HEAD.", 400);
    const hasUpstream = await gitRun(directory, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    if (hasUpstream.code === 0) {
      await git(directory, ["push"], 240_000);
    } else {
      // No upstream yet: push and set one, which fails with a clear git error
      // when no origin remote is configured.
      await git(directory, ["push", "-u", "origin", branch], 240_000);
    }
    const upstream = (
      await gitRun(directory, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    ).stdout.trim();
    return { ok: true, branch, upstream: upstream || null };
  });
}

const FILE_BYTES = 256 * 1024;

async function fileLocation(path: string, file: string) {
  const project = await projectDirectory(path);
  if (!(await insideWorkTree(project)))
    throw new RuntimeError("Choose a git repository first.", 400);
  const root = await realpath((await git(project, ["rev-parse", "--show-toplevel"])).trim());
  const target = resolve(root, file);
  const contained = (value: string) => {
    const rel = relative(root, value);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!contained(target)) throw new RuntimeError("File must be inside the repository.", 400);
  try {
    if (!contained(await realpath(target)))
      throw new RuntimeError("File must be inside the repository.", 400);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Deleted paths still need a diff, but their existing parent must be inside the repo.
    let parent = resolve(target, "..");
    while (parent !== root) {
      try {
        if (!contained(await realpath(parent)))
          throw new RuntimeError("File must be inside the repository.", 400);
        break;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
        parent = resolve(parent, "..");
      }
    }
  }
  return { root, target };
}

function registerGitFileRoutes(app: FastifyInstance): void {
  app.post("/api/git/file", async (request) => {
    const input = gitFileInputSchema.parse(request.body);
    const { target } = await fileLocation(input.path, input.file);
    let handle;
    try {
      if (!(await stat(target)).isFile()) throw new RuntimeError("Choose a regular file.", 400);
      handle = await open(target, "r");
      const buffer = Buffer.alloc(FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, Math.min(bytesRead, FILE_BYTES));
      if (bytes.includes(0))
        throw new RuntimeError("Binary files cannot be displayed as text.", 400);
      return { content: bytes.toString("utf8"), truncated: bytesRead > FILE_BYTES };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new RuntimeError(
          "File does not exist in the working tree. View its diff instead.",
          404,
        );
      throw error;
    } finally {
      await handle?.close();
    }
  });

  app.post("/api/git/diff", async (request) => {
    const input = gitFileInputSchema.parse(request.body);
    const { root, target } = await fileLocation(input.path, input.file);
    const head = await gitRun(root, ["rev-parse", "--verify", "HEAD"]);
    const inHead =
      head.code === 0 ? await gitRun(root, ["cat-file", "-e", `HEAD:${input.file}`]) : { code: 1 };
    const args =
      inHead.code === 0
        ? [
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "HEAD",
            "--",
            input.file,
          ]
        : [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--",
            "/dev/null",
            target,
          ];
    try {
      const result = await asyncExecFile("git", args, {
        cwd: root,
        timeout: 30_000,
        maxBuffer: FILE_BYTES,
        windowsHide: true,
      });
      return { diff: result.stdout, truncated: false };
    } catch (error) {
      const failure = error as GitFailure & { stdout?: string };
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        return { diff: (failure.stdout ?? "").slice(0, FILE_BYTES), truncated: true };
      if (failure.code === 1 && failure.stdout) return { diff: failure.stdout, truncated: false };
      return gitFailure(error);
    }
  });
}

export function registerGitRoutes(app: FastifyInstance): void {
  registerGitStatusRoutes(app);
  registerGitCommitRoutes(app);
  registerGitPushRoutes(app);
  registerGitFileRoutes(app);
}
