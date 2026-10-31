import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendSetup } from "./BackendSetup";
import { BACKEND_KEY } from "../lib/transport";

const { nativeFetch, permission, notify } = vi.hoisted(() => ({
  nativeFetch: vi.fn(),
  permission: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: nativeFetch }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: permission,
  sendNotification: notify,
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});
const health = {
  status: "ok",
  database: "ok",
  version: "0.1.0",
  instanceId: "c770e678-a310-4de7-8212-9b36777efad1",
  uptimeSeconds: 10,
};
describe("desktop connection setup", () => {
  it("saves a validated healthy connection and opens the workspace explicitly", async () => {
    nativeFetch.mockResolvedValue(new Response(JSON.stringify(health)));
    const connected = vi.fn();
    render(<BackendSetup onConnected={connected} />);
    fireEvent.change(screen.getByLabelText("Local backend URL"), {
      target: { value: "http://localhost:9898/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and save connection" }));
    await screen.findByText(/Healthy · version/);
    expect(localStorage.getItem(BACKEND_KEY)).toBe("http://localhost:9898");
    expect(connected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(connected).toHaveBeenCalledOnce();
  });
  it("preserves the saved backend when a new connection fails and rejects external hosts", async () => {
    localStorage.setItem(BACKEND_KEY, "http://127.0.0.1:8787");
    nativeFetch.mockRejectedValue(new Error("Connection refused"));
    render(<BackendSetup onConnected={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Local backend URL"), {
      target: { value: "http://localhost:9999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and save connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection refused");
    expect(localStorage.getItem(BACKEND_KEY)).toBe("http://127.0.0.1:8787");
    fireEvent.change(screen.getByLabelText("Local backend URL"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and save connection" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Use a local backend URL"),
    );
    expect(nativeFetch).toHaveBeenCalledOnce();
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
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Vektor" }));
  });
});
