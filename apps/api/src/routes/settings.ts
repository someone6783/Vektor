import type { FastifyInstance } from "fastify";
import { makeApiError, updateSettingsSchema } from "@vektor/shared";
import {
  FALLBACK_MODELS,
  MissingProviderKeyError,
  type ProviderService,
} from "../providers/service.js";

function toSettingsView(service: ProviderService) {
  const key = service.getKey();
  const cache = service.getCachedModels();

  return {
    openRouterConfigured: key.source !== "none",
    openRouterSource: key.source,
    defaultModel: service.getDefaultModel(),
    models: cache.models.length > 0 ? cache.models : FALLBACK_MODELS,
    modelsFetchedAt: cache.fetchedAt > 0 ? new Date(cache.fetchedAt).toISOString() : null,
  };
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  providerService: ProviderService,
): void {
  app.get("/api/settings", async () => toSettingsView(providerService));

  app.put("/api/settings", async (request) => {
    const input = updateSettingsSchema.parse(request.body);

    if (input.openRouterKey !== undefined) {
      providerService.saveKey(input.openRouterKey);
    }
    if (input.defaultModel !== undefined) {
      providerService.setDefaultModel(input.defaultModel);
    }

    return toSettingsView(providerService);
  });

  app.post("/api/settings/provider/test", async (request, reply) => {
    try {
      const models = await providerService.refreshModels();

      return {
        ok: true,
        models,
        modelsFetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof MissingProviderKeyError) {
        return reply.code(400).send(
          makeApiError("provider_not_configured", error.message, {
            requestId: request.id,
          }),
        );
      }

      return reply
        .code(502)
        .send(
          makeApiError(
            "provider_error",
            error instanceof Error ? error.message : "Provider connection test failed.",
            { requestId: request.id },
          ),
        );
    }
  });
}
