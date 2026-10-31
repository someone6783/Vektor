import Fastify, { type FastifyInstance } from "fastify";
import { makeApiError } from "@vektor/shared";
import type { Storage } from "./bootstrap.js";
import type { AppConfig } from "./config.js";
import { registerAuth } from "./plugins/auth.js";
import { createChatProvider, type ChatProvider } from "./providers/index.js";
import { registerDevProviderRoutes } from "./routes/dev-provider.js";
import { registerDevStreamRoutes } from "./routes/dev-stream.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerWebApp } from "./static.js";
import { createStreamRegistry } from "./stream-registry.js";

export interface BuildAppOptions {
  config: AppConfig;
  storage: Storage;
  logger?: boolean;
  provider?: ChatProvider;
}

export async function buildApp({
  config,
  storage,
  logger = true,
  provider: injectedProvider,
}: BuildAppOptions): Promise<FastifyInstance> {
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

  registerAuth(app, storage.accessToken);
  registerHealthRoutes(app, storage);

  const streams = createStreamRegistry();

  const provider =
    injectedProvider ??
    createChatProvider({
      apiKey: config.openRouterKey,
      baseUrl: config.openRouterBaseUrl,
    });

  if (config.enableDevStream) {
    registerDevStreamRoutes(app, config.devStreamDelayMs, streams);
    registerDevProviderRoutes(app, provider, config.openRouterModel, streams);
  }

  await registerWebApp(app, config.webDistDir);

  app.setErrorHandler((error, request, reply) => {
    const normalized = error as { statusCode?: number; message?: string };
    const status = normalized.statusCode ?? 500;
    const isServerError = status >= 500;

    if (isServerError) {
      request.log.error({ err: error }, "request failed");
    } else {
      request.log.warn({ err: error }, "request rejected");
    }

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

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(
      makeApiError("not_found", "Route not found.", {
        requestId: request.id,
      }),
    ),
  );

  app.addHook("preClose", async () => {
    streams.closeAll();
  });

  app.addHook("onClose", async () => {
    storage.sqlite.close();
  });

  return app;
}
