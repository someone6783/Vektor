import { buildApp } from "./app.js";
import { bootstrapStorage } from "./bootstrap.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = bootstrapStorage(config);
  const app = await buildApp({ config, storage });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");

    const forceExit = setTimeout(() => {
      app.log.error("shutdown timed out");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await app.close();
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

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
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
  console.error(error);
  process.exit(1);
});
