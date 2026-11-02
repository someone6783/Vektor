import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.resetModules();
});
describe("browser setup links", () => {
  it("removes the fragment before exchange and shares one request across duplicate mounts", async () => {
    window.history.replaceState(null, "", "/?signin=1#setup=synthetic-single-use-link");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect(window.location.hash).toBe("");
      expect(window.location.search).toBe("");
      return new Response(JSON.stringify({ authenticated: true }));
    });
    const { connectBrowserSession } = await import("./session");
    expect(await Promise.all([connectBrowserSession(), connectBrowserSession()])).toEqual([
      true,
      true,
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/auth/session",
      expect.objectContaining({
        credentials: "same-origin",
        body: JSON.stringify({ code: "synthetic-single-use-link" }),
      }),
    );
  });
  it("reports expired links without leaving credentials in browser history", async () => {
    window.history.replaceState(null, "", "/#setup=expired-link");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("expired", { status: 401 }));
    const { connectBrowserSession } = await import("./session");
    await expect(connectBrowserSession()).rejects.toThrow("expired");
    expect(window.location.hash).toBe("");
  });
  it("detects an existing cookie without requesting or storing the API token", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const { connectBrowserSession } = await import("./session");
    expect(await connectBrowserSession()).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/session", { credentials: "same-origin" });
  });
});
