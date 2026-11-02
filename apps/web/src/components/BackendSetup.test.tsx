import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendSetup } from "./BackendSetup";
import { BACKEND_KEY } from "../lib/transport";
const { invoke, permission, notify } = vi.hoisted(() => ({
  invoke: vi.fn(),
  permission: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: permission,
  sendNotification: notify,
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});
const connection = {
  baseUrl: "http://127.0.0.1:9898",
  token: "synthetic-test-credential",
  mode: "local",
};
describe("desktop connection setup", () => {
  it("installs the local service and signs in automatically before opening the workspace", async () => {
    invoke.mockImplementation(async (command) =>
      command === "install_local_service" ? connection : undefined,
    );
    const connected = vi.fn();
    render(<BackendSetup onConnected={connected} />);
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Install service and open workspace" }));
    await waitFor(() => expect(connected).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("save_backend", { connection });
    expect(localStorage.getItem(BACKEND_KEY)).toBe(connection.baseUrl);
    expect(localStorage.getItem(`vektor.accessToken:${connection.baseUrl}`)).toBe(connection.token);
  });
  it("discovers Docker credentials for the selected API URL without installing a local service", async () => {
    invoke.mockImplementation(async (command) =>
      command === "connect_docker" ? { ...connection, mode: "docker" } : undefined,
    );
    const connected = vi.fn();
    render(<BackendSetup onConnected={connected} />);
    fireEvent.click(screen.getByRole("radio", { name: /Connect to Docker/ }));
    fireEvent.change(screen.getByLabelText("Local backend URL"), {
      target: { value: "http://localhost:9898/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect and open workspace" }));
    await waitFor(() => expect(connected).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("connect_docker", { baseUrl: "http://localhost:9898" });
    expect(invoke.mock.calls.some(([command]) => command === "install_local_service")).toBe(false);
  });
  it("preserves a saved connection after failure and prevents external credential discovery", async () => {
    localStorage.setItem(BACKEND_KEY, "http://127.0.0.1:8787");
    invoke.mockRejectedValue(new Error("Docker is not running"));
    render(<BackendSetup onConnected={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Connect to Docker/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect and open workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Docker is not running");
    expect(localStorage.getItem(BACKEND_KEY)).toBe("http://127.0.0.1:8787");
    invoke.mockClear();
    fireEvent.change(screen.getByLabelText("Local backend URL"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect and open workspace" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Use a local backend URL"),
    );
    expect(invoke).not.toHaveBeenCalled();
  });
  it("only enables completion notifications after OS permission is granted", async () => {
    permission.mockResolvedValueOnce("denied").mockResolvedValueOnce("granted");
    render(<BackendSetup onConnected={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox", { name: "Notify when a run finishes" });
    fireEvent.click(checkbox);
    await screen.findByRole("alert");
    expect(checkbox).not.toBeChecked();
    expect(notify).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(localStorage.getItem("vektor.desktop.notifications")).toBe("true");
  });
});
