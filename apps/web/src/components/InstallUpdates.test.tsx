import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ApiClient } from "../lib/api";
import { InstallUpdates } from "./InstallUpdates";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(invoke).mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function client() {
  const api = new ApiClient("test");
  vi.spyOn(api, "updateInstallState").mockResolvedValue({
    configured: true,
    state: "idle",
    message: "Ready",
  });
  return api;
}
describe("click-to-install updates", () => {
  it("checks the desktop automatically but installs only after a click", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValue("0.2.0");
    render(<InstallUpdates client={client()} enabled />);
    const button = await screen.findByRole("button", {
      name: "Install desktop v0.2.0 and restart",
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("check_desktop_update");
    fireEvent.click(button);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("install_desktop_update"));
  });
  it("queues the Docker update only on a click and shows the restart guidance", async () => {
    const api = client();
    const install = vi
      .spyOn(api, "installBackendUpdate")
      .mockResolvedValue({ configured: true, state: "queued", message: "Queued" });
    render(<InstallUpdates client={api} enabled backendAvailable />);
    const button = await screen.findByRole("button", { name: "Install latest backend update" });
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(button);
    await screen.findByText(/Updating the API and Web UI/);
    expect(install).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Updating backend…" })).toBeDisabled();
  });
  it("offers no install actions when opted out, unavailable or already current", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const api = client();
    const { rerender } = render(<InstallUpdates client={api} enabled={false} backendAvailable />);
    await waitFor(() => expect(api.updateInstallState).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    vi.mocked(invoke).mockResolvedValue(null);
    rerender(<InstallUpdates client={api} enabled />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("shows a failed install and permits retry", async () => {
    const api = client();
    vi.spyOn(api, "installBackendUpdate").mockRejectedValue(
      new Error("Wait for active runs to finish."),
    );
    render(<InstallUpdates client={api} enabled backendAvailable />);
    const button = await screen.findByRole("button", { name: "Install latest backend update" });
    fireEvent.click(button);
    await screen.findByText("Wait for active runs to finish.");
    expect(button).toBeEnabled();
  });
});
