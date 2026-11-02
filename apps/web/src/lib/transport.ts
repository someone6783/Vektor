import { isTauri } from "@tauri-apps/api/core";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";

export const DEFAULT_BACKEND = "http://127.0.0.1:8787";
export const BACKEND_KEY = "vektor.desktop.backend";

export function normalizeBackend(value: string): string {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Use a local backend URL such as http://127.0.0.1:8787, without a path or credentials.",
    );
  }
  return url.origin;
}

export function backendUrl(): string {
  if (!isTauri()) return "";
  try {
    return normalizeBackend(localStorage.getItem(BACKEND_KEY) ?? DEFAULT_BACKEND);
  } catch {
    return DEFAULT_BACKEND;
  }
}

export function tokenStorageKey(): string {
  return isTauri() ? `vektor.accessToken:${backendUrl()}` : "vektor.accessToken";
}

// Native HTTP preserves streaming, uploads and cancellation without opening API CORS.
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!isTauri()) {
    const headers = new Headers(init?.headers);
    if (headers.get("Authorization") === "Bearer @session") headers.delete("Authorization");
    return fetch(path, { ...init, headers, credentials: "same-origin" });
  }
  return nativeFetch(`${backendUrl()}${path}`, {
    ...init,
    maxRedirections: 0,
    connectTimeout: 5000,
  });
}
