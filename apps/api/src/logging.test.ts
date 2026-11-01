import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { LogStream } from "./logging.js";
import { makeRedactor } from "./runtime/redact.js";
import { bootstrapStorage } from "./bootstrap.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("durable JSON logs", () => {
  it("sanitizes actual request URLs, headers, bodies and provider errors before stdout or disk", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vektor-request-logs-"));
    directories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      VEKTOR_DATA_DIR: directory,
      VEKTOR_WEB_DIST: join(directory, "no-web"),
      VEKTOR_ACCESS_TOKEN: "synthetic-access-credential",
      VEKTOR_OPENROUTER_KEY: "synthetic-provider-credential",
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let text = "";
    try {
      const app = await buildApp({ config, storage: bootstrapStorage(config), logger: true });
      app.post("/api/log-test", async () => {
        throw new Error("Provider failure: synthetic-provider-credential");
      });
      const providerFetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("synthetic-provider-credential", { status: 401 }));
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/log-test?private=synthetic-query-credential",
          headers: {
            authorization: "Bearer synthetic-access-credential",
            cookie: "synthetic-cookie-credential",
          },
          payload: { secret: "synthetic-body-credential" },
        });
        expect(response.statusCode).toBe(500);
        const connectionTest = await app.inject({
          method: "POST",
          url: "/api/settings/provider/test",
          headers: { authorization: "Bearer synthetic-access-credential" },
        });
        expect(connectionTest.statusCode).toBe(502);
        expect(connectionTest.payload).toContain("[redacted]");
        expect(connectionTest.payload).not.toContain("synthetic-provider-credential");
      } finally {
        providerFetch.mockRestore();
        await app.close();
      }
      text = output.mock.calls.map((args) => String(args[0])).join("");
    } finally {
      output.mockRestore();
    }
    const disk = readFileSync(join(directory, "logs", "vektor.jsonl"), "utf8");
    for (const value of [
      "synthetic-access-credential",
      "synthetic-provider-credential",
      "synthetic-query-credential",
      "synthetic-cookie-credential",
      "synthetic-body-credential",
    ]) {
      expect(text).not.toContain(value);
      expect(disk).not.toContain(value);
    }
    expect(disk).toContain("[redacted]");
    expect(
      disk
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .some((record) => record.reqId),
    ).toBe(true);
  });
  it("rotates bounded private files, preserves JSON, and redacts nested errors, keys and rotated credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vektor-logs-"));
    directories.push(directory);
    let secrets = ['synthetic"old-private-key'];
    const redact = makeRedactor(() => secrets);
    const stream = new LogStream({
      directory,
      redact: (text) => redact(text, false),
      maxBytes: 1024,
      retained: 3,
      file: true,
      stdout: false,
    });
    const logger = pino({ serializers: { err: pino.stdSerializers.err } }, stream);
    logger.info("captured credential before rotation");
    secrets = ["synthetic-new-private-key"];
    for (let n = 0; n < 30; n++)
      logger.error(
        {
          n,
          err: new Error('synthetic"old-private-key synthetic-new-private-key'),
          nested: { authorization: "another-credential" },
        },
        "request failed",
      );
    logger.error(
      {
        credentials: ['synthetic"old-private-key', "synthetic-new-private-key"],
        nested: { authorization: "another-credential" },
      },
      "redacted record",
    );
    logger.info({ payload: "x".repeat(5000) }, "too big");
    await new Promise<void>((resolve) => stream.end(resolve));
    const files = readdirSync(directory);
    expect(files).toHaveLength(3);
    const text = files
      .map((name) => {
        const path = join(directory, name);
        expect(statSync(path).size).toBeLessThanOrEqual(1024);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        return readFileSync(path, "utf8");
      })
      .join("");
    expect(text).not.toContain("old-private-key");
    expect(text).not.toContain("new-private-key");
    expect(text).not.toContain("another-credential");
    expect(text).toContain("[redacted]");
    expect(text).toContain("Oversized log record omitted");
    for (const line of text.trim().split("\n")) expect(JSON.parse(line)).toHaveProperty("level");
  });
});
