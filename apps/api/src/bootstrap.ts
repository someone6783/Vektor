import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureDefaultProfile,
  getOrCreateInstanceId,
  openDatabase,
  runMigrations,
  type OpenedDatabase,
} from "@vektor/db";
import type { AppConfig } from "./config.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface Storage extends OpenedDatabase {
  dataDir: string;
  instanceId: string;
  accessToken: string;
  secretsKey: Buffer;
}

export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  chmodSync(path, DIR_MODE);
}

function ensureTokenFile(path: string): string {
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString("hex"), { mode: FILE_MODE });
  }
  chmodSync(path, FILE_MODE);
  return readFileSync(path, "utf8").trim();
}

function ensureBinarySecretFile(path: string, bytes: number): Buffer {
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(bytes), { mode: FILE_MODE });
  }
  chmodSync(path, FILE_MODE);

  const value = readFileSync(path);
  if (value.length !== bytes) {
    throw new Error(`${path} must contain exactly ${bytes} bytes.`);
  }
  return value;
}

export function bootstrapStorage(config: AppConfig): Storage {
  ensureDirectory(config.dataDir);
  for (const name of ["files", "workspace", "logs"]) {
    ensureDirectory(join(config.dataDir, name));
  }

  const secretsKey = ensureBinarySecretFile(join(config.dataDir, "secrets.key"), 32);

  const accessToken =
    config.accessTokenOverride ?? ensureTokenFile(join(config.dataDir, "access-token"));

  const opened = openDatabase(join(config.dataDir, "vektor.db"));

  try {
    runMigrations(opened.db);
    ensureDefaultProfile(opened.db);

    return {
      ...opened,
      dataDir: config.dataDir,
      instanceId: getOrCreateInstanceId(opened.db),
      accessToken,
      secretsKey,
    };
  } catch (error) {
    opened.sqlite.close();
    throw error;
  }
}
