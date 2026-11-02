import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerState } from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { ComputerPanel } from "./ComputerPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const session: ComputerState = {
  active: true,
  paused: false,
  sensitive: false,
  phase: "active",
  mode: "control",
  session: "isolated",
  width: 800,
  height: 600,
  app: "Message",
  windows: [{ id: "42", title: "Phase 10 test" }],
  cursor: { x: 10, y: 20 },
  actions: 2,
};
function blob() {
  URL.createObjectURL = vi.fn(() => "blob:desktop");
  URL.revokeObjectURL = vi.fn();
  return new Blob([Buffer.from([0xff, 0xd8])], { type: "image/jpeg" });
}

describe("isolated computer UI", () => {
  it("explains an unavailable backend instead of pretending to control the host desktop", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "computerCapabilities").mockResolvedValue({
      available: false,
      reason: "The backend is missing xdotool.",
      location: "backend-isolated",
    });
    vi.spyOn(client, "computerState").mockResolvedValue({
      ...session,
      active: false,
      phase: "idle",
    });
    render(<ComputerPanel client={client} runId="run" active />);
    await screen.findByText("The backend is missing xdotool.");
    expect(screen.getByText(/The desktop starts on demand/)).toBeTruthy();
  });

  it("shows the virtual desktop and sends manual controls and screenshots", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "computerCapabilities").mockResolvedValue({
      available: true,
      reason: null,
      location: "backend-isolated",
    });
    vi.spyOn(client, "computerState").mockResolvedValue(session);
    const shot = vi.spyOn(client, "computerScreenshot").mockResolvedValue(blob());
    const control = vi.spyOn(client, "computerControl").mockResolvedValue(undefined);
    const input = vi.spyOn(client, "computerInput").mockResolvedValue({});
    render(<ComputerPanel client={client} runId="run" active />);
    const image = await screen.findByRole("img", { name: /isolated virtual desktop/i });
    expect(image.getAttribute("src")).toBe("blob:desktop");
    expect(shot).toHaveBeenCalledWith("run");
    expect(screen.getByText(/42 · Phase 10 test/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
    await waitFor(() => expect(input).toHaveBeenCalledWith("run", { action: "screenshot" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith("run", "pause"));
    fireEvent.click(screen.getByRole("button", { name: "Close desktop" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith("run", "close"));
  });

  it("disables mutating controls in observation-only mode", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "computerCapabilities").mockResolvedValue({
      available: true,
      reason: null,
      location: "backend-isolated",
    });
    vi.spyOn(client, "computerState").mockResolvedValue({ ...session, mode: "observe" });
    vi.spyOn(client, "computerScreenshot").mockResolvedValue(blob());
    render(<ComputerPanel client={client} runId="run" active />);
    await screen.findByRole("img", { name: /isolated virtual desktop/i });
    expect(screen.getByRole("button", { name: "Click" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Key" })).toBeDisabled();
  });
  it("keeps private controls separate from agent Resume and clears typed values", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "computerCapabilities").mockResolvedValue({
      available: true,
      reason: null,
      location: "backend-isolated",
    });
    vi.spyOn(client, "computerState").mockResolvedValue({
      ...session,
      sensitive: true,
      paused: true,
    });
    vi.spyOn(client, "computerArtifacts").mockResolvedValue([]);
    vi.spyOn(client, "computerScreenshot").mockResolvedValue(blob());
    const input = vi.spyOn(client, "computerInput").mockResolvedValue({});
    render(<ComputerPanel client={client} runId="run" active />);
    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    const field = screen.getByPlaceholderText("Private text (starts takeover)");
    expect(field).toHaveAttribute("type", "password");
    fireEvent.change(field, { target: { value: "private fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    await waitFor(() =>
      expect(input).toHaveBeenCalledWith("run", { action: "type", text: "private fixture" }),
    );
    expect(field).toHaveValue("");
  });

  it("loads authenticated action screenshots on request and deletes saved images", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "computerCapabilities").mockResolvedValue({
      available: true,
      reason: null,
      location: "backend-isolated",
    });
    vi.spyOn(client, "computerState").mockResolvedValue(session);
    vi.spyOn(client, "computerScreenshot").mockResolvedValue(blob());
    vi.spyOn(client, "computerArtifacts").mockResolvedValue([
      {
        id: "saved",
        runId: "run",
        actionId: "action",
        action: "move",
        stage: "before",
        size: 100,
        createdAt: "2026-11-02T00:00:00Z",
        expiresAt: "2026-11-09T00:00:00Z",
      },
    ]);
    const load = vi.spyOn(client, "computerArtifact").mockResolvedValue(blob());
    const remove = vi.spyOn(client, "deleteComputerArtifacts").mockResolvedValue(undefined);
    render(<ComputerPanel client={client} runId="run" active={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /move · before/ }));
    await screen.findByAltText("Saved desktop action screenshot");
    expect(load).toHaveBeenCalledWith("saved");
    fireEvent.click(screen.getByRole("button", { name: "Delete action screenshots" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("run"));
    await waitFor(() =>
      expect(screen.queryByAltText("Saved desktop action screenshot")).toBeNull(),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});
