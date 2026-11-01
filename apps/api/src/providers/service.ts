import { deleteSetting, getSetting, setSetting, type VektorDatabase } from "@vektor/db";
import type { ModelInfo } from "@vektor/shared";
import { decryptSecret, encryptSecret } from "../secrets.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { createChatProvider } from "./index.js";
import type { ChatProvider } from "./types.js";

const KEY_SETTING = "provider.openrouter.key";
const MODELS_SETTING = "provider.openrouter.models";
const DEFAULT_MODEL_SETTING = "provider.default_model";

export const FALLBACK_MODEL = "openrouter/auto";
export const FALLBACK_MODELS: ModelInfo[] = [{ id: FALLBACK_MODEL, name: "OpenRouter Auto" }];

export type KeySource = "env" | "stored" | "none";

interface CachedModels {
  fetchedAt: number;
  models: ModelInfo[];
}

export interface ProviderServiceOptions {
  db: VektorDatabase;
  secretsKey: Buffer;
  envKey?: string;
  baseUrl: string;
  providerOverride?: ChatProvider;
}

export class MissingProviderKeyError extends Error {
  constructor() {
    super("No OpenRouter key is configured.");
    this.name = "MissingProviderKeyError";
  }
}

export class ProviderService {
  private readonly db: VektorDatabase;
  private readonly secretsKey: Buffer;
  private readonly envKey?: string;
  private readonly baseUrl: string;
  private readonly providerOverride?: ChatProvider;

  constructor(options: ProviderServiceOptions) {
    this.db = options.db;
    this.secretsKey = options.secretsKey;
    this.envKey = options.envKey;
    this.baseUrl = options.baseUrl;
    this.providerOverride = options.providerOverride;
  }

  getKey(): { key?: string; source: KeySource } {
    if (this.envKey) {
      return { key: this.envKey, source: "env" };
    }

    const stored = getSetting(this.db, KEY_SETTING);
    if (typeof stored === "string" && stored.length > 0) {
      try {
        return { key: decryptSecret(stored, this.secretsKey), source: "stored" };
      } catch {
        return { source: "none" };
      }
    }

    return { source: "none" };
  }

  isConfigured(): boolean {
    return this.getKey().source !== "none";
  }

  getChatProvider(): ChatProvider {
    if (this.providerOverride) {
      return this.providerOverride;
    }

    return createChatProvider({
      apiKey: this.getKey().key,
      baseUrl: this.baseUrl,
    });
  }

  usesStub(): boolean {
    return !this.providerOverride && !this.isConfigured();
  }

  saveKey(key: string | null): void {
    if (key === null) {
      deleteSetting(this.db, KEY_SETTING);
    } else {
      setSetting(this.db, KEY_SETTING, encryptSecret(key, this.secretsKey));
    }
    deleteSetting(this.db, MODELS_SETTING);
  }

  getDefaultModel(): string {
    const stored = getSetting(this.db, DEFAULT_MODEL_SETTING);
    return typeof stored === "string" && stored.length > 0 ? stored : FALLBACK_MODEL;
  }

  setDefaultModel(model: string): void {
    setSetting(this.db, DEFAULT_MODEL_SETTING, model);
  }

  getCachedModels(): CachedModels {
    const stored = getSetting(this.db, MODELS_SETTING);
    if (
      stored &&
      typeof stored === "object" &&
      "models" in stored &&
      Array.isArray((stored as CachedModels).models)
    ) {
      const cache = stored as CachedModels;
      return {
        fetchedAt: typeof cache.fetchedAt === "number" ? cache.fetchedAt : 0,
        models: cache.models.filter(
          (model): model is ModelInfo =>
            typeof model === "object" &&
            model !== null &&
            typeof (model as ModelInfo).id === "string" &&
            typeof (model as ModelInfo).name === "string",
        ),
      };
    }

    return { fetchedAt: 0, models: [] };
  }

  async refreshModels(requireKey = true): Promise<ModelInfo[]> {
    const { key } = this.getKey();
    if (requireKey && !key) {
      throw new MissingProviderKeyError();
    }

    const provider =
      this.providerOverride && this.providerOverride.listModels
        ? this.providerOverride
        : new OpenRouterProvider({ apiKey: key ?? "", baseUrl: this.baseUrl });

    if (!provider.listModels) {
      throw new Error("The configured provider does not support model listing.");
    }

    const models = await provider.listModels();
    if (models.length === 0) {
      throw new Error("The provider returned no models.");
    }

    setSetting(this.db, MODELS_SETTING, { fetchedAt: Date.now(), models });
    return models;
  }
}
