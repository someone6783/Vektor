import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { makeApiError } from "@vektor/shared";
import type { Storage } from "./bootstrap.js";
import type { AppConfig } from "./config.js";
import { registerAuth } from "./plugins/auth.js";
import type { ChatProvider } from "./providers/index.js";
import { ProviderService } from "./providers/service.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerDevProviderRoutes } from "./routes/dev-provider.js";
import { registerDevStreamRoutes } from "./routes/dev-stream.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerRunEventRoutes } from "./routes/run-events.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { recoverInterruptedRuns } from "./runs/recovery.js";
import { RunManager } from "./runs/run-manager.js";
import { registerWebApp } from "./static.js";
import { createStreamRegistry } from "./stream-registry.js";
import { AttachmentService } from "./attachments/service.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { ContextService } from "./context.js";
import { join } from "node:path";
import { TerminalExecutor } from "./runtime/terminal.js";
import { makeRedactor } from "./runtime/redact.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";
import { Scheduler } from "./scheduling/scheduler.js";
import { registerJobRoutes } from "./routes/jobs.js";

export interface BuildAppOptions {
  config: AppConfig;
  storage: Storage;
  logger?: boolean;
  provider?: ChatProvider;
  schedulerClock?: () => number;
  startScheduler?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    scheduler: Scheduler;
  }
}
export type VektorApp = FastifyInstance;

export async function buildApp({
  config,
  storage,
  logger = true,
  provider: injectedProvider,
  schedulerClock,
  startScheduler = true,
}: BuildAppOptions): Promise<VektorApp> {
  const app = Fastify({
    logger: logger
      ? {
          level: config.logLevel,
          redact: {
            paths: ["req.headers.authorization", "req.headers.cookie"],
            censor: "[redacted]",
          },
        }
      : false,
    trustProxy: false,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send(
        makeApiError("validation_error", "Invalid request.", {
          requestId: request.id,
          details: error.issues,
        }),
      );
    }
    const normalized = error as { statusCode?: number; message?: string };
    const status = normalized.statusCode ?? 500;
    const isServerError = status >= 500;
    if (isServerError) request.log.error({ err: error }, "request failed");
    else request.log.warn({ err: error }, "request rejected");
    return reply
      .code(status)
      .send(
        makeApiError(
          isServerError ? "internal_error" : "request_error",
          isServerError ? "Internal server error." : (normalized.message ?? "Request failed."),
          { requestId: request.id },
        ),
      );
  });

  registerAuth(app, storage.accessToken);
  registerHealthRoutes(app, storage);

  const interrupted = recoverInterruptedRuns(storage.db);
  if (interrupted.length > 0) {
    app.log.warn({ runs: interrupted }, "marked interrupted runs as failed");
  }

  const streams = createStreamRegistry();
  const providerService = new ProviderService({
    db: storage.db,
    secretsKey: storage.secretsKey,
    ...(config.openRouterKey ? { envKey: config.openRouterKey } : {}),
    baseUrl: config.openRouterBaseUrl,
    ...(injectedProvider ? { providerOverride: injectedProvider } : {}),
  });

  const redact = makeRedactor(() => [
    storage.accessToken,
    storage.secretsKey.toString("hex"),
    storage.secretsKey.toString("base64"),
    storage.secretsKey.toString("utf8"),
    providerService.getKey().key ?? "",
  ]);
  const terminal = new TerminalExecutor(join(storage.dataDir, "workspace"), redact);
  const runManager = new RunManager({
    db: storage.db,
    getChatProvider: () => providerService.getChatProvider(),
    logger: app.log,
    terminal,
    redact,
    redactionHoldback: redact.holdback,
    runTimeoutMs: config.runTimeoutMs,
    now: schedulerClock,
  });

  registerSettingsRoutes(app, providerService);
  registerProfileRoutes(app, storage.db);
  registerChannelRoutes(app, storage.db);
  const attachments = new AttachmentService(
    storage.db,
    storage.dataDir,
    config.maxFileBytes,
    config.channelFileBytes,
  );
  await registerAttachmentRoutes(app, attachments);
  const context = new ContextService(storage.db, attachments, providerService);
  const scheduler = new Scheduler({
    db: storage.db,
    manager: runManager,
    context,
    redact,
    enabled: config.schedulerEnabled ?? true,
    tickMs: config.schedulerTickMs ?? 1000,
    now: schedulerClock,
    onError: (error) => app.log.error({ err: error }, "scheduler tick failed"),
  });
  app.decorate("scheduler", scheduler);
  registerJobRoutes(app, scheduler);
  if (startScheduler)
    app.addHook("onReady", async () => {
      scheduler.start();
    });
  registerMessageRoutes(app, storage.db, runManager, context);
  registerRunEventRoutes(app, storage.db, runManager, streams);
  registerRuntimeRoutes(app, storage.db, runManager, terminal, config.runtimeEnvironment ?? "host");

  if (config.enableDevStream) {
    registerDevStreamRoutes(app, config.devStreamDelayMs, streams);
    registerDevProviderRoutes(app, providerService, streams);
  }

  await registerWebApp(app, config.webDistDir);

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(
      makeApiError("not_found", "Route not found.", {
        requestId: request.id,
      }),
    ),
  );

  app.addHook("preClose", async () => {
    await scheduler.stop();
    await runManager.shutdown();
    scheduler.reconcile();
    streams.closeAll();
  });

  app.addHook("onClose", async () => {
    storage.sqlite.close();
  });

  return app;
}
