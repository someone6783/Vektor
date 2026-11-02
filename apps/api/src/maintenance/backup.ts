import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  openReadOnlyDatabase,
  snapshotDatabase,
  verifyMigrationHistory,
  type SqliteConnection,
} from "@vektor/db";
import { z } from "zod";
import { VERSION } from "../config.js";
import { acquireDataLock } from "./data-lock.js";

const entrySchema = z.discriminatedUnion("type", [
  z
    .object({
      path: z.string(),
      type: z.literal("file"),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      executable: z.boolean(),
    })
    .strict(),
  z.object({ path: z.string(), type: z.literal("directory") }).strict(),
  z.object({ path: z.string(), type: z.literal("symlink"), target: z.string() }).strict(),
]);
const manifestSchema = z
  .object({
    format: z.literal("vektor-backup"),
    version: z.literal(1),
    applicationVersion: z.string(),
    createdAt: z.string().datetime(),
    instanceId: z.string(),
    entries: z.array(entrySchema).max(1_000_000),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function validPath(path: string): boolean {
  return (
    !path.includes("\\") &&
    !path.includes("\0") &&
    !isAbsolute(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    (["vektor.db", "secrets.key", "access-token", "files", "workspace", "runners", "mcp"].includes(
      path,
    ) ||
      path.startsWith("files/") ||
      path.startsWith("workspace/") ||
      path.startsWith("runners/") ||
      path.startsWith("mcp/"))
  );
}
async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
function verifyDatabase(sqlite: SqliteConnection): void {
  verifyMigrationHistory(sqlite);
  if (
    sqlite.pragma("integrity_check", { simple: true }) !== "ok" ||
    (sqlite.pragma("foreign_key_check") as unknown[]).length
  )
    throw new Error("Backup database integrity check failed.");
  // Require the Vektor schema, not just an arbitrary valid SQLite file.
  sqlite.prepare("SELECT id FROM profiles LIMIT 1").all();
  sqlite.prepare("SELECT id FROM attachments LIMIT 1").all();
  if (!sqlite.prepare("SELECT hash FROM __drizzle_migrations").all().length)
    throw new Error("Backup database has no migration history.");
}
function validateLink(path: string, target: string): void {
  if (
    !path.startsWith("workspace/") ||
    isAbsolute(target) ||
    target.includes("\\") ||
    target.includes("\0") ||
    !inside("/workspace", resolve("/", path, "..", target))
  )
    throw new Error(`Backup contains a link outside the workspace: ${path}`);
}
async function snapshotEntry(
  source: string,
  destination: string,
  path: string,
  entries: Entry[],
): Promise<void> {
  if (!validPath(path)) throw new Error(`Unsupported backup path: ${path}`);
  const from = join(source, path);
  const to = join(destination, path);
  const stat = await lstat(from);
  if (stat.isSymbolicLink()) {
    const target = await readlink(from);
    validateLink(path, target);
    await symlink(target, to);
    entries.push({ path, type: "symlink", target });
  } else if (stat.isDirectory()) {
    await mkdir(to, { mode: 0o700 });
    entries.push({ path, type: "directory" });
    for (const name of (await readdir(from)).sort())
      await snapshotEntry(source, destination, `${path}/${name}`, entries);
  } else if (stat.isFile()) {
    await copyFile(from, to);
    const executable =
      (path.startsWith("workspace/") || path.startsWith("runners/")) && !!(stat.mode & 0o111);
    await chmod(to, executable ? 0o700 : 0o600);
    entries.push({ path, type: "file", size: stat.size, sha256: await hash(to), executable });
  } else throw new Error(`Backup cannot include special files: ${path}`);
}

export async function createBackup(dataDir: string, destination: string): Promise<void> {
  dataDir = resolve(dataDir);
  destination = resolve(destination);
  if (inside(dataDir, destination) || inside(destination, dataDir))
    throw new Error("Keep the backup and data directories separate.");
  const release = await acquireDataLock(dataDir);
  const staging = `${destination}.partial-${randomUUID()}`;
  let sqlite: SqliteConnection | undefined;
  try {
    try {
      await lstat(destination);
      throw new Error("Backup destination already exists.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!(await lstat(join(dataDir, "vektor.db"))).isFile())
      throw new Error("Data directory has no database.");
    await mkdir(staging, { mode: 0o700 });
    sqlite = openReadOnlyDatabase(join(dataDir, "vektor.db"));
    verifyDatabase(sqlite);
    const entries: Entry[] = [];
    await snapshotDatabase(sqlite, join(staging, "vektor.db"));
    await chmod(join(staging, "vektor.db"), 0o600);
    const dbStat = await lstat(join(staging, "vektor.db"));
    entries.push({
      path: "vektor.db",
      type: "file",
      size: dbStat.size,
      sha256: await hash(join(staging, "vektor.db")),
      executable: false,
    });
    for (const path of ["secrets.key", "files", "workspace"])
      await snapshotEntry(dataDir, staging, path, entries);
    for (const optional of ["runners", "mcp"]) {
      try {
        await lstat(join(dataDir, optional));
        await snapshotEntry(dataDir, staging, optional, entries);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    try {
      await lstat(join(dataDir, "access-token"));
      await snapshotEntry(dataDir, staging, "access-token", entries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const setting = sqlite
      .prepare("SELECT value_json AS value FROM settings WHERE key = 'app.instance_id'")
      .get() as { value: string };
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify(
        {
          format: "vektor-backup",
          version: 1,
          applicationVersion: VERSION,
          createdAt: new Date().toISOString(),
          instanceId: JSON.parse(setting.value),
          entries,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
    await verifyBackup(staging);
    await rename(staging, destination);
  } finally {
    sqlite?.close();
    await rm(staging, { recursive: true, force: true });
    await release();
  }
}

export async function verifyBackup(source: string) {
  if (!(await lstat(source)).isDirectory() || (await lstat(source)).isSymbolicLink())
    throw new Error("Backup must be a regular directory.");
  const manifestPath = join(source, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > 64 * 1024 * 1024
  )
    throw new Error("Invalid backup manifest.");
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const seen = new Map<string, Entry>();
  for (const entry of manifest.entries) {
    if (!validPath(entry.path) || seen.has(entry.path))
      throw new Error("Unsafe or duplicated backup path.");
    const parts = entry.path.split("/");
    parts.pop();
    if (parts.length && seen.get(parts.join("/"))?.type !== "directory")
      throw new Error("Backup path has a missing or unsafe parent.");
    seen.set(entry.path, entry);
    const path = join(source, entry.path);
    const stat = await lstat(path);
    if (entry.type === "file") {
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== entry.size ||
        (await hash(path)) !== entry.sha256
      )
        throw new Error(`Backup checksum or file type mismatch: ${entry.path}`);
    } else if (entry.type === "directory") {
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Backup directory type mismatch.");
    } else {
      validateLink(entry.path, entry.target);
      if (!stat.isSymbolicLink() || (await readlink(path)) !== entry.target)
        throw new Error("Backup link mismatch.");
    }
  }
  for (const name of ["vektor.db", "secrets.key"])
    if (seen.get(name)?.type !== "file") throw new Error(`Backup is missing ${name}.`);
  for (const name of ["files", "workspace"])
    if (seen.get(name)?.type !== "directory") throw new Error(`Backup is missing ${name}.`);
  if ((await readFile(join(source, "secrets.key"))).length !== 32)
    throw new Error("Invalid backup secrets key.");
  if (seen.has("access-token") && seen.get("access-token")?.type !== "file")
    throw new Error("Invalid backup access token file.");
  const sqlite = openReadOnlyDatabase(join(source, "vektor.db"));
  try {
    verifyDatabase(sqlite);
    const instance = sqlite
      .prepare("SELECT value_json AS value FROM settings WHERE key='app.instance_id'")
      .get() as { value: string } | undefined;
    if (!instance || JSON.parse(instance.value) !== manifest.instanceId)
      throw new Error("Backup instance metadata does not match the database.");
    const attachments = sqlite.prepare("SELECT id, size FROM attachments").all() as Array<{
      id: string;
      size: number;
    }>;
    for (const attachment of attachments) {
      const entry = seen.get(`files/${attachment.id}`);
      if (entry?.type !== "file" || entry.size !== attachment.size)
        throw new Error("Backup is missing a referenced attachment.");
    }
  } finally {
    sqlite.close();
  }
  return manifest;
}

export async function restoreBackup(source: string, dataDir: string): Promise<void> {
  source = resolve(source);
  dataDir = resolve(dataDir);
  if (inside(source, dataDir) || inside(dataDir, source))
    throw new Error("Keep the backup and data directories separate.");
  const manifest = await verifyBackup(source);
  const release = await acquireDataLock(dataDir);
  const staging = join(dataDir, `.restore-${randomUUID()}`);
  const marker = join(dataDir, ".restore-in-progress");
  const promoted: string[] = [];
  try {
    if (
      (await readdir(dataDir)).some(
        (name) => ![".vektor-lock.db", ".vektor-lock.db-journal"].includes(name),
      )
    )
      throw new Error(
        "Restore requires an empty data directory. Existing data is never overwritten.",
      );
    await writeFile(marker, "Restore in progress\n", { flag: "wx", mode: 0o600 });
    await mkdir(staging, { mode: 0o700 });
    // Copy only validated manifest entries, never arbitrary unlisted files.
    for (const entry of manifest.entries) {
      const from = join(source, entry.path);
      const to = join(staging, entry.path);
      if (entry.type === "directory") await mkdir(to, { mode: 0o700 });
      else if (entry.type === "symlink") await symlink(entry.target, to);
      else {
        await copyFile(from, to);
        await chmod(to, entry.executable ? 0o700 : 0o600);
      }
    }
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    await verifyBackup(staging);
    for (const entry of manifest.entries.filter((entry) => !entry.path.includes("/"))) {
      await rename(join(staging, entry.path), join(dataDir, entry.path));
      promoted.push(entry.path);
    }
    await rm(marker);
  } catch (error) {
    for (const path of promoted) await rm(join(dataDir, path), { recursive: true, force: true });
    // Only remove our marker when this invocation created the staging directory.
    if (
      await lstat(staging).then(
        () => true,
        () => false,
      )
    )
      await rm(marker, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await release();
  }
}
