import { gt, prerelease, valid } from "semver";
import { z } from "zod";
import { deleteSetting, getSetting, setSetting, type VektorDatabase } from "@vektor/db";
import {
  APP_VERSION,
  RELEASE_REPOSITORY,
  RELEASE_REPOSITORY_PRIVATE,
  type UpdateCheck,
  type UpdatePreferences,
} from "@vektor/shared";
import { decryptSecret, encryptSecret } from "../secrets.js";
import { RuntimeError } from "../runtime/terminal.js";

export const UPDATE_CACHE_MS = 24 * 60 * 60 * 1000;
export const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const CACHE_KEY = "updates.result";
const cacheSchema = z
  .object({
    checkedAt: z.number().int().nonnegative(),
    latestVersion: z.string().nullable(),
    releaseUrl: z.string().nullable(),
    publishedAt: z.string().nullable(),
    error: z.enum(["offline", "rate_limited", "not_found", "invalid_response"]).nullable(),
  })
  .strict();
type Cache = z.infer<typeof cacheSchema>;
type Options = {
  db: VektorDatabase;
  secretsKey: Buffer;
  currentVersion?: string;
  envEnabled?: boolean;
  envToken?: string;
  repositoryPrivate?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export function releaseVersion(tag: string): string | null {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) &&
    valid(version) !== null
    ? version
    : null;
}
export function newerRelease(current: string, latest: string): boolean {
  return (
    releaseVersion(current) === current &&
    releaseVersion(latest) === latest &&
    prerelease(latest) === null &&
    gt(latest, current)
  );
}

export class UpdateService {
  private pending?: Promise<UpdateCheck>;
  private controller?: AbortController;
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private generation = 0;
  private closing = false;
  readonly now: () => number;
  readonly currentVersion: string;
  readonly repositoryPrivate: boolean;
  constructor(readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.currentVersion = options.currentVersion ?? APP_VERSION;
    this.repositoryPrivate = options.repositoryPrivate ?? RELEASE_REPOSITORY_PRIVATE;
  }
  get credential(): { token?: string; source: UpdateCheck["tokenSource"] } {
    if (this.options.envToken) return { token: this.options.envToken, source: "env" };
    const stored = getSetting(this.options.db, "updates.githubToken");
    if (typeof stored === "string") {
      try {
        return { token: decryptSecret(stored, this.options.secretsKey), source: "stored" };
      } catch {
        /* Treat unavailable credentials as unconfigured, never expose ciphertext. */
      }
    }
    return { source: "none" };
  }
  get enabled() {
    if (this.options.envEnabled === false) return false;
    const saved = getSetting(this.options.db, "updates.enabled");
    return typeof saved === "boolean"
      ? saved
      : (this.options.envEnabled ?? !this.repositoryPrivate);
  }
  private cache(): Cache | null {
    try {
      const value = cacheSchema.safeParse(getSetting(this.options.db, CACHE_KEY));
      if (!value.success || value.data.checkedAt > this.now()) return null;
      if (value.data.latestVersion && !releaseVersion(value.data.latestVersion)) return null;
      if (
        value.data.releaseUrl &&
        !value.data.releaseUrl.startsWith(`https://github.com/${RELEASE_REPOSITORY}/releases/tag/`)
      )
        return null;
      return value.data;
    } catch {
      return null;
    }
  }
  snapshot(cached = true): UpdateCheck {
    const value = this.cache();
    const enabled = this.enabled;
    const credential = this.credential;
    const tokenRequired = enabled && this.repositoryPrivate && !credential.token;
    const show = enabled && !tokenRequired;
    const updateAvailable =
      show && !!value?.latestVersion && newerRelease(this.currentVersion, value.latestVersion);
    return {
      currentVersion: this.currentVersion,
      repository: RELEASE_REPOSITORY,
      repositoryPrivate: this.repositoryPrivate,
      enabled,
      allowed: this.options.envEnabled !== false,
      tokenSource: credential.source,
      status: !enabled
        ? "disabled"
        : tokenRequired || value?.error
          ? "unavailable"
          : !value
            ? "unchecked"
            : updateAvailable
              ? "available"
              : "current",
      latestVersion: show ? (value?.latestVersion ?? null) : null,
      updateAvailable,
      releaseUrl: show ? (value?.releaseUrl ?? null) : null,
      publishedAt: show ? (value?.publishedAt ?? null) : null,
      checkedAt: value ? new Date(value.checkedAt).toISOString() : null,
      nextCheckAt:
        enabled && value ? new Date(value.checkedAt + UPDATE_CACHE_MS).toISOString() : null,
      error: tokenRequired ? "token_required" : show ? (value?.error ?? null) : null,
      cached: cached && value !== null,
    };
  }
  configure(patch: UpdatePreferences): UpdateCheck {
    if (patch.enabled && this.options.envEnabled === false)
      throw new RuntimeError("Update checks are disabled by backend configuration.", 423);
    if (patch.githubToken !== undefined && this.options.envToken)
      throw new RuntimeError("The GitHub token is managed by the backend environment.", 423);
    if (patch.enabled !== undefined) setSetting(this.options.db, "updates.enabled", patch.enabled);
    if (patch.githubToken === null) deleteSetting(this.options.db, "updates.githubToken");
    else if (patch.githubToken !== undefined)
      setSetting(
        this.options.db,
        "updates.githubToken",
        encryptSecret(patch.githubToken, this.options.secretsKey),
      );
    this.generation++;
    this.controller?.abort();
    deleteSetting(this.options.db, CACHE_KEY);
    return this.snapshot(false);
  }
  start() {
    if (this.timer || this.closing) return;
    const tick = () => {
      void this.check().catch(() => {});
    };
    this.first = setTimeout(tick, 0);
    this.first.unref();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
  }
  async stop() {
    this.closing = true;
    this.generation++;
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.controller?.abort();
    await this.pending?.catch(() => {});
  }
  async check(force = false): Promise<UpdateCheck> {
    if (this.closing || !this.enabled || (this.repositoryPrivate && !this.credential.token))
      return this.snapshot();
    if (this.pending) return this.pending;
    const cached = this.cache();
    if (!force && cached && this.now() - cached.checkedAt < UPDATE_CACHE_MS) return this.snapshot();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.fetchRelease(controller)
      .then((result) => {
        if (generation === this.generation && !this.closing && this.enabled)
          setSetting(this.options.db, CACHE_KEY, result);
        return this.snapshot(false);
      })
      .finally(() => {
        this.pending = undefined;
        if (this.controller === controller) this.controller = undefined;
      });
    return this.pending;
  }
  private async fetchRelease(controller: AbortController): Promise<Cache> {
    const empty = (error: Cache["error"]): Cache => ({
      checkedAt: this.now(),
      latestVersion: null,
      releaseUrl: null,
      publishedAt: null,
      error,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 5000);
      const signal = AbortSignal.any([controller.signal, timeout]);
      try {
        const token = this.repositoryPrivate ? this.credential.token : undefined;
        const response = await (this.options.fetchImpl ?? fetch)(RELEASE_API_URL, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          headers: {
            "User-Agent": `Vektor/${this.currentVersion}`,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal,
        });
        if ([403, 429].includes(response.status)) {
          await response.body?.cancel();
          return empty("rate_limited");
        }
        if (response.status === 404) {
          await response.body?.cancel();
          return empty("not_found");
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status >= 500 && attempt === 0) continue;
          return empty("offline");
        }
        const reader = response.body?.getReader();
        if (!reader) return empty("invalid_response");
        let text = "";
        let bytes = 0;
        const decoder = new TextDecoder();
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 64 * 1024) {
              await reader.cancel();
              return empty("invalid_response");
            }
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          reader.releaseLock();
        }
        const release = z
          .object({
            tag_name: z.string().max(200),
            draft: z.literal(false),
            prerelease: z.literal(false),
            published_at: z.string().datetime(),
          })
          .safeParse(JSON.parse(text));
        if (!release.success) return empty("invalid_response");
        const version = releaseVersion(release.data.tag_name);
        if (!version || prerelease(version) !== null) return empty("invalid_response");
        return {
          checkedAt: this.now(),
          latestVersion: version,
          releaseUrl: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${encodeURIComponent(release.data.tag_name)}`,
          publishedAt: release.data.published_at,
          error: null,
        };
      } catch (error) {
        if (error instanceof SyntaxError) return empty("invalid_response");
        if (controller.signal.aborted || attempt === 1) return empty("offline");
      }
    }
    return empty("offline");
  }
}
