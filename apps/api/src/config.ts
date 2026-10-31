import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const VERSION = "0.1.0";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().max(65535).default(8787),
  VEKTOR_DATA_DIR: z.string().min(1).optional(),
  VEKTOR_ACCESS_TOKEN: z.string().min(16).optional(),
  VEKTOR_ENABLE_DEV_STREAM: z.enum(["0", "1", "true", "false"]).optional(),
  VEKTOR_DEV_STREAM_DELAY_MS: z.coerce.number().int().min(0).max(5000).default(40),
  VEKTOR_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  VEKTOR_WEB_DIST: z.string().min(1).optional(),
  VEKTOR_OPENROUTER_KEY: z.string().min(1).optional(),
  VEKTOR_OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  VEKTOR_OPENROUTER_MODEL: z.string().min(1).default("openrouter/auto"),
  VEKTOR_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024)
    .default(25 * 1024 * 1024),
  VEKTOR_CHANNEL_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(250 * 1024 * 1024),
  VEKTOR_RUN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(120_000),
  VEKTOR_RUNTIME_ENV: z.enum(["host", "container"]).default("host"),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  dataDir: string;
  accessTokenOverride?: string;
  enableDevStream: boolean;
  devStreamDelayMs: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  webDistDir: string;
  version: string;
  openRouterKey?: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  maxFileBytes?: number;
  channelFileBytes?: number;
  runTimeoutMs?: number;
  runtimeEnvironment?: "host" | "container";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const isProduction = parsed.NODE_ENV === "production";
  const devStreamFlag = parsed.VEKTOR_ENABLE_DEV_STREAM;
  const defaultDataDir = isProduction
    ? "/data"
    : fileURLToPath(new URL("../../../.data", import.meta.url));

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir: resolve(parsed.VEKTOR_DATA_DIR ?? defaultDataDir),
    accessTokenOverride: parsed.VEKTOR_ACCESS_TOKEN,
    enableDevStream:
      devStreamFlag === undefined
        ? !isProduction
        : devStreamFlag === "1" || devStreamFlag === "true",
    devStreamDelayMs: parsed.VEKTOR_DEV_STREAM_DELAY_MS,
    logLevel: parsed.VEKTOR_LOG_LEVEL,
    webDistDir: parsed.VEKTOR_WEB_DIST
      ? resolve(parsed.VEKTOR_WEB_DIST)
      : fileURLToPath(new URL("../../web/dist", import.meta.url)),
    version: VERSION,
    openRouterKey: parsed.VEKTOR_OPENROUTER_KEY,
    openRouterBaseUrl: parsed.VEKTOR_OPENROUTER_BASE_URL,
    openRouterModel: parsed.VEKTOR_OPENROUTER_MODEL,
    maxFileBytes: parsed.VEKTOR_MAX_FILE_BYTES,
    channelFileBytes: parsed.VEKTOR_CHANNEL_FILE_BYTES,
    runTimeoutMs: parsed.VEKTOR_RUN_TIMEOUT_MS,
    runtimeEnvironment: parsed.VEKTOR_RUNTIME_ENV,
  };
}
