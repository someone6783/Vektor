import { buildApp } from "./app.js";
import { bootstrapStorage } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { acquireDataLock } from "./maintenance/data-lock.js";
import { makeRedactor } from "./runtime/redact.js";

async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadConfig();
  const release = await acquireDataLock(config.dataDir);
  let app;
  try {
    const storage = bootstrapStorage(config);
    app = await buildApp({ config, storage });
  } catch (error) {
    await release();
    throw error;
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");

    const forceExit = setTimeout(() => {
      app.log.error("shutdown timed out");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await app.close();
      await release();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "shutdown failed");
      process.exit(1);
    }
  };

  let shuttingDown = false;
  const onSignal = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void shutdown(signal);
  };

  if (process.env.VEKTOR_MANAGED_SERVICE === "1") {
    process.on("message", (message: unknown) => {
      if (message === "vektor:shutdown") onSignal("desktop");
    });
    process.on("disconnect", () => onSignal("supervisor disconnected"));
  }

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    await release();
    throw error;
  }
  app.log.info(
    {
      host: config.host,
      port: config.port,
      dataDir: config.dataDir,
      devStream: config.enableDevStream,
    },
    "vektor api listening",
  );
}

main().catch((error: unknown) => {
  const redact = makeRedactor(() => [
    process.env.VEKTOR_ACCESS_TOKEN ?? "",
    process.env.VEKTOR_OPENROUTER_KEY ?? "",
  ]);
  console.error(
    JSON.stringify({
      level: 50,
      time: Date.now(),
      msg: "Vektor startup failed",
      error: redact(error instanceof Error ? error.message : "Unknown startup error"),
    }),
  );
  process.exit(1);
});
