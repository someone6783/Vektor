import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./api";
import { apiFetch } from "./transport";
vi.mock("./transport", () => ({ apiFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it("explains a missing connect route as an outdated backend", async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: { code: "not_found", message: "Route not found." } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    }),
  );
  await expect(new ApiClient("fixture").connectRunner("codex")).rejects.toThrow("Restart Vektor");
});
it("preserves the backend's actionable authentication failure", async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({ error: { code: "runtime_error", message: "Run codex login." } }),
      { status: 409, headers: { "content-type": "application/json" } },
    ),
  );
  await expect(new ApiClient("fixture").connectRunner("codex")).rejects.toThrow("Run codex login.");
});
