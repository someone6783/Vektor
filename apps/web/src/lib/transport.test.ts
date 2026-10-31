import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, BACKEND_KEY, backendUrl, normalizeBackend, tokenStorageKey } from "./transport";

const { desktop, nativeFetch } = vi.hoisted(() => ({
  desktop: { active: false },
  nativeFetch: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => desktop.active }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: nativeFetch }));
afterEach(() => {
  desktop.active = false;
  localStorage.clear();
  vi.restoreAllMocks();
  nativeFetch.mockReset();
});
describe("desktop transport", () => {
  it("accepts only local backend origins without credentials, paths or query parameters", () => {
    for (const url of [
      "http://127.0.0.1:8787/",
      "http://localhost:8787",
      "http://[::1]:8787",
      "https://localhost:443",
    ])
      expect(normalizeBackend(url)).toBe(new URL(url).origin);
    for (const url of [
      "https://example.com",
      "file:///tmp/backend",
      "http://localhost:8787/api",
      "http://user:secret@localhost:8787",
      "http://localhost:8787?token=x",
      "http://localhost:8787#fragment",
    ])
      expect(() => normalizeBackend(url)).toThrow();
  });
  it("keeps web requests relative and preserves the web token key", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await apiFetch("/healthz");
    expect(fetch).toHaveBeenCalledWith("/healthz", undefined);
    expect(tokenStorageKey()).toBe("vektor.accessToken");
  });
  it("uses native HTTP for streaming, upload bodies and aborts, with redirects disabled", async () => {
    desktop.active = true;
    localStorage.setItem(BACKEND_KEY, "http://localhost:9876");
    const controller = new AbortController();
    const body = new FormData();
    body.append("file", new Blob(["test"]), "test.txt");
    nativeFetch.mockResolvedValue(new Response("stream"));
    await apiFetch("/api/channels/a/attachments", {
      method: "POST",
      body,
      signal: controller.signal,
      headers: { Authorization: "Bearer test" },
    });
    expect(nativeFetch).toHaveBeenCalledWith(
      "http://localhost:9876/api/channels/a/attachments",
      expect.objectContaining({ body, signal: controller.signal, maxRedirections: 0 }),
    );
    expect(tokenStorageKey()).toBe("vektor.accessToken:http://localhost:9876");
    localStorage.setItem(BACKEND_KEY, "http://127.0.0.1:8787");
    expect(tokenStorageKey()).not.toBe("vektor.accessToken:http://localhost:9876");
    localStorage.setItem(BACKEND_KEY, "https://untrusted.example");
    expect(backendUrl()).toBe("http://127.0.0.1:8787");
  });
});
