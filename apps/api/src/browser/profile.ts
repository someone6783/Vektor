import { z } from "zod";
import { deleteSetting, getSetting, setSetting, type VektorDatabase } from "@vektor/db";
import type { BrowserPermissions } from "@vektor/shared";
import { decryptSecret, encryptSecret } from "../secrets.js";
import { RuntimeError } from "../runtime/terminal.js";
import type { BrowserStorageState } from "./controller.js";

const KEY = "browser.defaultProfile";
const DATE = "browser.defaultProfile.savedAt";
const stateSchema = z.object({
  cookies: z.array(z.object({ domain: z.string() }).passthrough()),
  origins: z.array(z.object({ origin: z.string().url() }).passthrough()),
});
const MAX_BYTES = 4 * 1024 * 1024;
function scope(permissions: BrowserPermissions) {
  const origins = new Set([...permissions.allowedOrigins, ...permissions.localOrigins]);
  const hosts = [...origins].map((value) => new URL(value).hostname);
  return {
    origin: (value: string) => origins.has(value),
    cookie: (domain: string) => {
      const name = domain.replace(/^\./, "").toLowerCase();
      return hosts.some((host) => host === name || host.endsWith(`.${name}`));
    },
  };
}
export class DefaultBrowserProfileStore {
  constructor(
    readonly db: VektorDatabase,
    readonly key: Buffer,
  ) {}
  get info() {
    const date = getSetting(this.db, DATE);
    return {
      configured: typeof getSetting(this.db, KEY) === "string",
      savedAt: typeof date === "string" ? date : null,
    };
  }
  private read(): BrowserStorageState {
    const stored = getSetting(this.db, KEY);
    if (stored === undefined) return { cookies: [], origins: [] };
    try {
      if (typeof stored !== "string" || stored.length > MAX_BYTES * 2) throw new Error();
      return stateSchema.parse(JSON.parse(decryptSecret(stored, this.key))) as BrowserStorageState;
    } catch {
      throw new RuntimeError(
        "The saved default browser profile is unavailable. Reset it in Settings before reconnecting.",
        409,
      );
    }
  }
  load(permissions: BrowserPermissions): BrowserStorageState {
    const value = this.read();
    const allowed = scope(permissions);
    return {
      cookies: value.cookies.filter((cookie) => allowed.cookie(cookie.domain)),
      origins: value.origins.filter((origin) => allowed.origin(origin.origin)),
    };
  }
  save(value: BrowserStorageState, permissions: BrowserPermissions) {
    const old = this.read();
    const allowed = scope(permissions);
    const combined: BrowserStorageState = {
      cookies: [
        ...old.cookies.filter((cookie) => !allowed.cookie(cookie.domain)),
        ...value.cookies.filter((cookie) => allowed.cookie(cookie.domain)),
      ],
      origins: [
        ...old.origins.filter((origin) => !allowed.origin(origin.origin)),
        ...value.origins.filter((origin) => allowed.origin(origin.origin)),
      ],
    };
    const raw = JSON.stringify(combined);
    if (Buffer.byteLength(raw) > MAX_BYTES)
      throw new RuntimeError("The saved browser profile exceeds its 4 MiB storage limit.", 413);
    this.db.transaction((db) => {
      setSetting(db, KEY, encryptSecret(raw, this.key));
      setSetting(db, DATE, new Date().toISOString());
    });
  }
  reset() {
    this.db.transaction((db) => {
      deleteSetting(db, KEY);
      deleteSetting(db, DATE);
    });
  }
}
