import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import type { AppConfig } from "./config.js";

function clean(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => clean(item, redact));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|cookie|set-cookie|password|token|accessToken|apiKey|secretsKey|secret)$/i.test(
          key,
        )
          ? "[redacted]"
          : clean(item, redact),
      ]),
    );
  return value;
}

export class LogStream extends Writable {
  private fd: number | undefined;
  private bytes = 0;
  readonly path: string;
  constructor(
    readonly options: {
      directory: string;
      redact: (value: string) => string;
      maxBytes: number;
      retained: number;
      file: boolean;
      stdout?: boolean;
    },
  ) {
    super();
    this.path = join(options.directory, "vektor.jsonl");
    if (options.file) this.open();
  }
  private open() {
    this.fd = openSync(this.path, "a", 0o600);
    chmodSync(this.path, 0o600);
    this.bytes = statSync(this.path).size;
  }
  private rotate() {
    closeSync(this.fd!);
    for (let index = this.options.retained - 1; index >= 1; index--) {
      const from = index === 1 ? this.path : `${this.path}.${index - 1}`;
      if (existsSync(from)) renameSync(from, `${this.path}.${index}`);
    }
    // Retention of one keeps just the current file.
    this.fd = openSync(this.path, "w", 0o600);
    this.bytes = 0;
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    try {
      let record =
        JSON.stringify(clean(JSON.parse(chunk.toString("utf8")), this.options.redact)) + "\n";
      if (Buffer.byteLength(record) > this.options.maxBytes) {
        const parsed = JSON.parse(record) as { level?: number; time?: number };
        record =
          JSON.stringify({
            level: parsed.level,
            time: parsed.time,
            msg: "Oversized log record omitted",
            truncated: true,
          }) + "\n";
      }
      if (this.fd !== undefined) {
        if (this.bytes && this.bytes + Buffer.byteLength(record) > this.options.maxBytes)
          this.rotate();
        writeSync(this.fd!, record);
        this.bytes += Buffer.byteLength(record);
      }
      if (this.options.stdout !== false) process.stdout.write(record);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
  override _final(callback: (error?: Error | null) => void) {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
    callback();
  }
}

export function createAppLogger(config: AppConfig, redact: (value: string) => string) {
  const stream = new LogStream({
    directory: join(config.dataDir, "logs"),
    redact,
    maxBytes: config.logMaxBytes ?? 10 * 1024 * 1024,
    retained: config.logRetainedFiles ?? 5,
    file: config.logFile ?? true,
  });
  const logger = pino(
    {
      level: config.logLevel,
      serializers: {
        req: (req: { method?: string; url?: string; hostname?: string; ip?: string }) => ({
          method: req.method,
          url: req.url?.split("?")[0],
          hostname: req.hostname,
          remoteAddress: req.ip,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
        err: pino.stdSerializers.err,
      },
    },
    stream,
  );
  return {
    logger,
    close: () =>
      new Promise<void>((resolve, reject) =>
        stream.end((error?: Error | null) => (error ? reject(error) : resolve())),
      ),
  };
}
