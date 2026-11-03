import type { isolatedRunner } from "./runners/isolation.js";
import { RunnerInstallations } from "./runners/installations.js";
import { ExternalRunners } from "./runners/service.js";
import { RunnerSetup } from "./runners/setup.js";
import { registerRunnerRoutes } from "./routes/runners.js";
import { RuntimeError } from "./runtime/terminal.js";
import { listRunningRuns } from "@vektor/db";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";
import { makeApiError } from "@vektor/shared";
import type { Storage } from "./bootstrap.js";
import type { AppConfig } from "./config.js";
import { BrowserSessions } from "./plugins/sessions.js";
import { registerAuth } from "./plugins/auth.js";
import type { ChatProvider } from "./providers/index.js";
import { ProviderService } from "./providers/service.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerDevProviderRoutes } from "./routes/dev-provider.js";
import { registerDevStreamRoutes } from "./routes/dev-stream.js";
import { registerGitRoutes } from "./routes/git.js";
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
import { SshService } from "./ssh/service.js";
import { registerSshRoutes } from "./routes/ssh.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";
import { Scheduler } from "./scheduling/scheduler.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { createAppLogger } from "./logging.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { DesktopReleases, registerDesktopUpdateRoutes } from "./updates/install.js";
import { UpdateService } from "./updates/service.js";
import { registerUpdateRoutes } from "./routes/updates.js";
import { BrowserService } from "./browser/service.js";
import { registerBrowserRoutes } from "./routes/browser.js";
import type { BrowserController, BrowserSessionOptions } from "./browser/controller.js";
import type { BrowserDesktop } from "./browser/desktop.js";
import { ComputerService } from "./computer/service.js";
import { registerComputerRoutes } from "./routes/computer.js";
import type { ComputerController, ComputerSessionOptions } from "./computer/controller.js";
import type { ComputerCapabilities } from "@vektor/shared";

export interface BuildAppOptions {
  runnerIsolation?: typeof isolatedRunner;
  config: AppConfig;
  storage: Storage;
  logger?: boolean;
  provider?: ChatProvider;
  schedulerClock?: () => number;
  startScheduler?: boolean;
  updateFetch?: typeof fetch;
  browserFactory?: (options: BrowserSessionOptions) => BrowserController;
  browserDesktop?: BrowserDesktop;
  computerFactory?: (options: ComputerSessionOptions) => ComputerController;
  computerCapabilities?: ComputerCapabilities;
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
  updateFetch,
  browserFactory,
  browserDesktop,
  computerFactory,
  computerCapabilities,
  runnerIsolation,
}: BuildAppOptions): Promise<VektorApp> {
  const providerService = new ProviderService({
    db: storage.db,
    secretsKey: storage.secretsKey,
    ...(config.openRouterKey ? { envKey: config.openRouterKey } : {}),
    baseUrl: config.openRouterBaseUrl,
    ...(injectedProvider ? { providerOverride: injectedProvider } : {}),
  });
  const updates = new UpdateService({
    db: storage.db,
    secretsKey: storage.secretsKey,
    currentVersion: config.version,
    envEnabled: config.updateCheck,
    envToken: config.githubToken,
    fetchImpl: updateFetch,
  });
  const runnerInstallations = new RunnerInstallations(
    storage.db,
    storage.dataDir,
    storage.secretsKey,
  );
  const external = new ExternalRunners(
    storage.db,
    runnerInstallations,
    storage.dataDir,
    storage.secretsKey,
    runnerIsolation,
  );
  const mcp = new McpService(storage.db, storage.dataDir, storage.secretsKey, config.port);
  const ssh = new SshService(storage.db, storage.secretsKey);
  const redact = makeRedactor(() => [
    ...mcp.store.secrets(),
    ...runnerInstallations.secrets(),
    ...ssh.secrets(),
    storage.accessToken,
    storage.secretsKey.toString("hex"),
    storage.secretsKey.toString("base64"),
    storage.secretsKey.toString("utf8"),
    providerService.getKey().key ?? "",
    updates.credential.token ?? "",
  ]);
  mcp.setRedactor((value) => redact(value, false));
  const logging = logger ? createAppLogger(config, (text) => redact(text, false)) : null;
  const serverOptions: FastifyServerOptions = {
    ...(logging ? { loggerInstance: logging.logger } : { logger: false }),
    trustProxy: false,
  };
  const app = Fastify(serverOptions);

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
          isServerError
            ? "internal_error"
            : error instanceof RuntimeError && error.code
              ? error.code
              : "request_error",
          isServerError
            ? "Internal server error."
            : redact(normalized.message ?? "Request failed."),
          { requestId: request.id },
        ),
      );
  });

  const sessions = new BrowserSessions(storage.accessToken);
  registerAuth(app, storage.accessToken, sessions);
  sessions.register(app);
  registerHealthRoutes(app, storage);
  app.get("/api/backend", async () => ({
    dataDir: storage.dataDir,
    workspaceDir: join(storage.dataDir, "workspace"),
    executionEnvironment: config.runtimeEnvironment ?? "host",
  }));

  const interrupted = recoverInterruptedRuns(storage.db);
  if (interrupted.length > 0) {
    app.log.warn({ runs: interrupted }, "marked interrupted runs as failed");
  }

  const streams = createStreamRegistry();
  const terminal = new TerminalExecutor(join(storage.dataDir, "workspace"), redact);
  const attachments = new AttachmentService(
    storage.db,
    storage.dataDir,
    config.maxFileBytes,
    config.channelFileBytes,
  );
  const browser = new BrowserService({
    secretsKey: storage.secretsKey,
    db: storage.db,
    attachments,
    dataDir: storage.dataDir,
    redact,
    protectedPort: config.port,
    ttlDays: config.browserArtifactDays,
    factory: browserFactory,
    desktop: browserDesktop,
  });
  await browser.initialize();
  const computer = new ComputerService({
    db: storage.db,
    dataDir: storage.dataDir,
    redact,
    factory: computerFactory,
    ...(computerCapabilities ? { capabilities: computerCapabilities } : {}),
  });
  await computer.initialize();
  const runnerSetup = new RunnerSetup(storage.db);
  const runManager = new RunManager({
    mcp,
    external,
    stopExternal: () => runnerSetup.stop(),
    db: storage.db,
    getChatProvider: () => providerService.getChatProvider(),
    logger: app.log,
    terminal,
    ssh,
    browser,
    computer,
    supportsModelTools: (model) =>
      providerService.getCachedModels().models.find((item) => item.id === model)?.supportsTools,
    supportsModelImages: (model) =>
      providerService.getCachedModels().models.find((item) => item.id === model)?.supportsImages,
    redact,
    redactionHoldback: redact.holdback,
    runTimeoutMs: config.runTimeoutMs,
    now: schedulerClock,
  });

  registerRunnerRoutes(app, storage.db, runnerSetup, runnerInstallations, external, runManager);
  registerMcpRoutes(app, mcp, runManager);
  registerSettingsRoutes(app, providerService, redact);
  registerSshRoutes(app, ssh);
  registerGitRoutes(app);
  registerProfileRoutes(
    app,
    storage.db,
    (profileId) => runManager.revokeBrowser(profileId),
    (profileId) => runManager.revokeComputer(profileId),
    async (profileId) => {
      await runManager.revokeExternal(profileId);
      await runManager.revokeMcp({ profileId });
    },
  );
  registerChannelRoutes(app, storage.db, (id) => runManager.revokeConversation(id));
  await registerAttachmentRoutes(app, attachments);
  const context = new ContextService(storage.db, attachments, providerService, mcp);
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
  registerUsageRoutes(app, storage.db);
  registerUpdateRoutes(app, updates, async () => {
    if (listRunningRuns(storage.db).length)
      throw new RuntimeError("Wait for active runs to finish before installing an update.", 409);
    await runManager.emergencyStop();
  });
  registerDesktopUpdateRoutes(app, new DesktopReleases(updates, updateFetch));
  registerBrowserRoutes(app, storage.db, runManager);
  registerComputerRoutes(app, storage.db, runManager);
  if (config.nodeEnv !== "test")
    app.addHook("onReady", async () => {
      updates.start();
    });

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
    await updates.stop();
    await scheduler.stop();
    await runManager.shutdown();
    scheduler.reconcile();
    streams.closeAll();
  });

  app.addHook("onClose", async () => {
    await logging?.close();
    storage.sqlite.close();
  });

  return app;
}
import { McpService } from "./mcp/service.js";
import { registerMcpRoutes } from "./routes/mcp.js";
