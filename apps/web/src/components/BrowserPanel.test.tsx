import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserState } from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { BrowserPanel } from "./BrowserPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const session: BrowserState = {
  mode: "interactive",
  active: true,
  paused: false,
  sensitive: false,
  url: "https://example.com",
  tabs: [{ id: "tab", url: "https://example.com" }],
  actions: 3,
  snapshot: "UNTRUSTED PAGE DATA\ne1_0: input Name",
};
describe("managed browser UI", () => {
  it("opens a configured visible window and offers focus after it starts", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "browserCapabilities").mockResolvedValue({
      visibleWindowAvailable: true,
      reason: null,
      windowLocation: "backend",
    });
    const load = vi.spyOn(client, "browserState").mockResolvedValue({
      session: { ...session, active: false, phase: "idle", display: "window" },
      artifacts: [],
    });
    const control = vi.spyOn(client, "browserControl").mockResolvedValue(undefined);
    render(<BrowserPanel client={client} runId="run" active />);
    const open = await screen.findByRole("button", { name: "Open browser window" });
    load.mockResolvedValue({
      session: { ...session, display: "window", phase: "active" },
      artifacts: [],
    });
    fireEvent.click(open);
    await screen.findByRole("button", { name: "Focus browser window" });
    expect(control).toHaveBeenCalledWith("run", "open");
    fireEvent.click(screen.getByRole("button", { name: "Focus browser window" }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith("run", "focus"));
  });
  it("explains a backend with no display and disables visible launch", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "browserCapabilities").mockResolvedValue({
      visibleWindowAvailable: false,
      reason: "The backend has no desktop display.",
      windowLocation: "backend",
    });
    vi.spyOn(client, "browserState").mockResolvedValue({
      session: { ...session, active: false, display: "window", phase: "idle" },
      artifacts: [],
    });
    render(<BrowserPanel client={client} runId="run" active />);
    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: "Open browser window" })).toBeDisabled();
  });
  it("pauses for takeover, submits a scoped element action, clears the draft and resumes", async () => {
    const client = new ApiClient("test");
    const load = vi.spyOn(client, "browserState").mockResolvedValue({ session, artifacts: [] });
    const control = vi.spyOn(client, "browserControl").mockResolvedValue(undefined);
    const input = vi.spyOn(client, "browserInput").mockResolvedValue({});
    render(<BrowserPanel client={client} runId="run" active />);
    await screen.findByText(/Agent active/);
    load.mockResolvedValue({ session: { ...session, paused: true }, artifacts: [] });
    fireEvent.click(screen.getByRole("button", { name: "Pause and take over" }));
    await screen.findByLabelText("Browser takeover action");
    expect(control).toHaveBeenCalledWith("run", "pause");
    fireEvent.change(screen.getByLabelText("Browser takeover action"), {
      target: { value: "fill" },
    });
    fireEvent.change(screen.getByLabelText("Browser takeover target"), {
      target: { value: "e1_0" },
    });
    fireEvent.change(screen.getByLabelText("Browser takeover value"), {
      target: { value: "private draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Perform action" }));
    await waitFor(() => expect(screen.getByLabelText("Browser takeover value")).toHaveValue(""));
    expect(input).toHaveBeenCalledWith("run", {
      action: "fill",
      ref: "e1_0",
      text: "private draft",
      privateInput: true,
    });
    load.mockResolvedValue({ session, artifacts: [] });
    fireEvent.click(screen.getByRole("button", { name: "Resume agent" }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith("run", "resume"));
  });
  it("shows retained artifact controls and explains suppressed private previews", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "browserState").mockResolvedValue({
      session: { ...session, sensitive: true },
      artifacts: [
        {
          id: "artifact",
          runId: "run",
          origin: "https://example.com",
          createdAt: "2026-11-01T00:00:00Z",
          expiresAt: "2026-11-08T00:00:00Z",
          size: 100,
        },
      ],
    });
    vi.spyOn(client, "deleteBrowserArtifacts").mockResolvedValue(undefined);
    render(<BrowserPanel client={client} runId="run" active />);
    await screen.findByText(/Private input suppresses page previews/);
    fireEvent.click(screen.getByRole("button", { name: "Delete retained screenshots" }));
    await waitFor(() => expect(client.deleteBrowserArtifacts).toHaveBeenCalledWith("run"));
  });
});
