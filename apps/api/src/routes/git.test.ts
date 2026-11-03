import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitCommitResultSchema, gitStatusSchema } from "@vektor/shared";
import { buildApp } from "../app.js";
import { bootstrapStorage } from "../bootstrap.js";
import type { AppConfig } from "../config.js";

const ACCESS_TOKEN = "test-token-1234567890";

function testConfig(dataDir: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir,
    accessTokenOverride: ACCESS_TOKEN,
    enableDevStream: false,
    logLevel: "silent",
    webDistDir: join(dataDir, "missing-web-dist"),
    version: "0.1.0",
    openRouterBaseUrl: "https://openrouter.ai/api/v1",
    openRouterModel: "openrouter/auto",
  };
}

function repository(gitFile?: boolean): string {
  const directory = mkdtempSync(join(tmpdir(), "vektor-git-repo-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: directory });
  run(["init", "-b", "main", "--quiet"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(directory, "committed.txt"), "committed\n");
  run(["add", "committed.txt"]);
  run(["commit", "-q", "-m", "first commit"]);
  if (gitFile) {
    writeFileSync(join(directory, "untracked.txt"), "untracked\n");
    writeFileSync(join(directory, "committed.txt"), "committed\nmodified\n");
  }
  return directory;
}

let dataDir: string;
let app: FastifyInstance;
const repos: string[] = [];

function inject(path: string, body?: unknown) {
  return app.inject({
    method: "POST",
    url: path,
    headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    body: body ?? {},
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "vektor-api-git-"));
  app = await buildApp({
    config: testConfig(dataDir),
    storage: bootstrapStorage(testConfig(dataDir)),
    logger: false,
  });
});

afterEach(async () => {
  await app.close();
  for (const directory of repos) rmSync(directory, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("POST /api/git/status", () => {
  it("requires a token", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/git/status", body: { path: "/tmp" } }))
        .statusCode,
    ).toBe(401);
  });

  it("reports a clean repository with branch and last commit", async () => {
    const repo = repository();
    repos.push(repo);
    const response = await inject("/api/git/status", { path: repo });
    expect(response.statusCode).toBe(200);
    const status = gitStatusSchema.parse(response.json());
    expect(status.repository).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.files).toEqual([]);
    expect(status.lastCommit?.subject).toBe("first commit");
  });

  it("lists modified and untracked files", async () => {
    const repo = repository(true);
    repos.push(repo);
    const response = await inject("/api/git/status", { path: repo });
    expect(response.statusCode).toBe(200);
    const status = gitStatusSchema.parse(response.json());
    const paths = status.files.map((file) => file.path);
    expect(paths).toContain("committed.txt");
    expect(paths).toContain("untracked.txt");
    const modified = status.files.find((file) => file.path === "committed.txt");
    expect(modified?.worktree).toBe("M");
    const untracked = status.files.find((file) => file.path === "untracked.txt");
    expect(untracked?.untracked).toBe(true);
  });

  it("returns repository false for a plain directory", async () => {
    const missing = mkdtempSync(join(tmpdir(), "vektor-git-plain-"));
    repos.push(missing);
    const response = await inject("/api/git/status", { path: missing });
    expect(response.statusCode).toBe(200);
    expect(gitStatusSchema.parse(response.json()).repository).toBe(false);
  });

  it("rejects paths that do not exist", async () => {
    const relative = await inject("/api/git/status", { path: "relative/path" });
    expect(relative.statusCode).toBe(400);
    const absent = await inject("/api/git/status", { path: "/definitely/not/a/place" });
    expect(absent.statusCode).toBe(400);
  });
});

describe("POST /api/git/commit", () => {
  it("stages selected files and creates a commit", async () => {
    const repo = repository(true);
    repos.push(repo);
    const response = await inject("/api/git/commit", {
      path: repo,
      message: "panel commit",
      files: ["committed.txt", "untracked.txt"],
    });
    expect(response.statusCode).toBe(200);
    const result = gitCommitResultSchema.parse(response.json());
    expect(result.branch).toBe("main");
    const status = gitStatusSchema.parse((await inject("/api/git/status", { path: repo })).json());
    expect(status.files.map((file) => file.path)).toEqual([]);
    expect(status.lastCommit?.subject).toBe("panel commit");
  });

  it("rejects an empty selection and empty message", async () => {
    const repo = repository(true);
    repos.push(repo);
    expect(
      (await inject("/api/git/commit", { path: repo, message: "x", files: [] })).statusCode,
    ).toBe(400);
    expect(
      (await inject("/api/git/commit", { path: repo, message: "   ", files: ["committed.txt"] }))
        .statusCode,
    ).toBe(400);
  });

  it("reports nothing to commit once changes are committed", async () => {
    const repo = repository(true);
    repos.push(repo);
    const response = await inject("/api/git/commit", {
      path: repo,
      message: "panel commit",
      files: ["committed.txt", "untracked.txt"],
    });
    expect(response.statusCode).toBe(200);
    const nothing = await inject("/api/git/commit", {
      path: repo,
      message: "already clean",
      files: ["committed.txt"],
    });
    expect(nothing.statusCode).toBe(400);
  });

  it("rejects paths outside the repository", async () => {
    const repo = repository(true);
    repos.push(repo);
    expect(
      (
        await inject("/api/git/commit", {
          path: repo,
          message: "escape attempts",
          files: ["../../etc/passwd"],
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("POST /api/git/push", () => {
  it("fails for a repository without a remote and reports detached heads", async () => {
    const repo = repository(true);
    repos.push(repo);
    const response = await inject("/api/git/push", { path: repo });
    expect(response.statusCode).toBe(400);
    execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: repo });
    const detached = await inject("/api/git/push", { path: repo });
    expect(detached.statusCode).toBe(400);
    execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });
  });

  it("validates missing directories", async () => {
    const missing = await inject("/api/git/push", { path: "/definitely/not/a/place" });
    expect(missing.statusCode).toBe(400);
  });
});

describe("git file viewing", () => {
  it("shows combined staged and unstaged changes, and current raw content", async () => {
    const repo = repository();
    repos.push(repo);
    writeFileSync(join(repo, "committed.txt"), "committed\nstaged\n");
    execFileSync("git", ["add", "committed.txt"], { cwd: repo });
    writeFileSync(join(repo, "committed.txt"), "committed\nstaged\nworking\n");
    const body = { path: repo, file: "committed.txt" };
    const diff = await inject("/api/git/diff", body);
    expect(diff.statusCode).toBe(200);
    expect(diff.json().diff).toContain("+staged");
    expect(diff.json().diff).toContain("+working");
    const raw = await inject("/api/git/file", body);
    expect(raw.statusCode).toBe(200);
    expect(raw.json()).toEqual({ content: "committed\nstaged\nworking\n", truncated: false });
  });

  it("shows new files, unborn repositories, and staged deletions", async () => {
    const repo = repository(true);
    repos.push(repo);
    expect(
      (await inject("/api/git/diff", { path: repo, file: "untracked.txt" })).json().diff,
    ).toContain("+untracked");
    execFileSync("git", ["rm", "committed.txt", "-f"], { cwd: repo });
    const deleted = { path: repo, file: "committed.txt" };
    expect((await inject("/api/git/diff", deleted)).json().diff).toContain("-committed");
    expect((await inject("/api/git/file", deleted)).statusCode).toBe(404);
    const unborn = mkdtempSync(join(tmpdir(), "vektor-git-unborn-"));
    repos.push(unborn);
    execFileSync("git", ["init", "--quiet"], { cwd: unborn });
    writeFileSync(join(unborn, "new.txt"), "new file\n");
    expect(
      (await inject("/api/git/diff", { path: unborn, file: "new.txt" })).json().diff,
    ).toContain("+new file");
  });

  it("requires authentication and rejects traversal, external symlinks, and binary raw content", async () => {
    const repo = repository();
    repos.push(repo);
    writeFileSync(join(repo, "binary"), Buffer.from([0, 1, 2]));
    symlinkSync(dataDir, join(repo, "external"));
    for (const endpoint of ["file", "diff"]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/git/${endpoint}`,
            body: { path: repo, file: "committed.txt" },
          })
        ).statusCode,
      ).toBe(401);
      for (const file of ["../outside", "/etc/passwd", "external/missing.txt"]) {
        expect((await inject(`/api/git/${endpoint}`, { path: repo, file })).statusCode).toBe(400);
      }
    }
    expect((await inject("/api/git/file", { path: repo, file: "binary" })).statusCode).toBe(400);
    expect((await inject("/api/git/diff", { path: repo, file: "binary" })).json().diff).toContain(
      "Binary files",
    );
  });

  it("bounds raw and diff output and treats pathspec characters literally", async () => {
    const repo = repository();
    repos.push(repo);
    writeFileSync(join(repo, "large.txt"), "line\n".repeat(100000));
    const body = { path: repo, file: "large.txt" };
    const raw = (await inject("/api/git/file", body)).json();
    expect(raw.truncated).toBe(true);
    expect(Buffer.byteLength(raw.content)).toBe(256 * 1024);
    const diff = await inject("/api/git/diff", body);
    expect(diff.statusCode).toBe(200);
    expect(diff.json().truncated).toBe(true);
    writeFileSync(join(repo, "[x].txt"), "before\n");
    execFileSync("git", ["add", "--", "[x].txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "literal filename"], { cwd: repo });
    writeFileSync(join(repo, "[x].txt"), "after\n");
    expect((await inject("/api/git/diff", { path: repo, file: "[x].txt" })).json().diff).toContain(
      "+after",
    );
  });
});
