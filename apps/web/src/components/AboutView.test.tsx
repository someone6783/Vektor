import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION, type UpdateCheck } from "@vektor/shared";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ApiClient } from "../lib/api";
import { AboutView } from "./AboutView";
import { ReleaseLink } from "./ReleaseLink";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const info: UpdateCheck = {
  currentVersion: APP_VERSION,
  repository: "someone6783/Vektor",
  repositoryPrivate: true,
  enabled: false,
  allowed: true,
  tokenSource: "none",
  status: "disabled",
  latestVersion: null,
  updateAvailable: false,
  releaseUrl: null,
  publishedAt: null,
  checkedAt: null,
  nextCheckAt: null,
  error: null,
  cached: false,
};
describe("About and release controls", () => {
  it("shows versions, saves a write-only token, toggles checking, and forces a check", async () => {
    const client = new ApiClient("test");
    const load = vi.spyOn(client, "updateCheck").mockResolvedValue(info);
    const save = vi
      .spyOn(client, "updatePreferences")
      .mockResolvedValue({ ...info, tokenSource: "stored" });
    render(<AboutView client={client} />);
    await screen.findByText(`App v${APP_VERSION} · Backend v${APP_VERSION}`);
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
    const token = screen.getByLabelText("GitHub release token");
    fireEvent.change(token, { target: { value: "write-only-test-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    await waitFor(() => expect(token).toHaveValue(""));
    expect(save).toHaveBeenCalledWith({ githubToken: "write-only-test-token" });
    save.mockResolvedValue({ ...info, enabled: true, tokenSource: "stored", status: "unchecked" });
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled());
    expect(save).toHaveBeenLastCalledWith({ enabled: true });
    load.mockResolvedValue({
      ...info,
      enabled: true,
      tokenSource: "stored",
      status: "available",
      latestVersion: "0.2.0",
      updateAvailable: true,
      releaseUrl: "https://github.com/someone6783/Vektor/releases/tag/v0.2.0",
      checkedAt: "2026-11-01T00:00:00Z",
    });
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByRole("link", { name: /Update available/ })).toHaveAttribute(
      "href",
      "https://github.com/someone6783/Vektor/releases/tag/v0.2.0",
    );
    expect(load).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(/docker compose pull/)).toBeInTheDocument();
  });
  it("respects a backend opt-out and environment-managed credential", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "updateCheck").mockResolvedValue({
      ...info,
      allowed: false,
      tokenSource: "env",
    });
    render(<AboutView client={client} />);
    await screen.findByText(/Disabled by VEKTOR_UPDATE_CHECK/);
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.queryByLabelText("GitHub release token")).not.toBeInTheDocument();
  });
  it("shows quiet offline status and version mismatch", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "updateCheck").mockResolvedValue({
      ...info,
      currentVersion: "0.0.1",
      enabled: true,
      error: "offline",
      status: "unavailable",
    });
    render(<AboutView client={client} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Unable to check");
    expect(screen.getByText(/App and backend versions differ/)).toBeInTheDocument();
  });
  it("opens desktop release links in the system browser and rejects unrelated URLs", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(openUrl).mockResolvedValue(undefined);
    const href = "https://github.com/someone6783/Vektor/releases/tag/v0.2.0";
    const { rerender } = render(<ReleaseLink href={href}>Release</ReleaseLink>);
    fireEvent.click(screen.getByRole("link"));
    expect(openUrl).toHaveBeenCalledWith(href);
    rerender(<ReleaseLink href="https://evil.example/">Bad</ReleaseLink>);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
