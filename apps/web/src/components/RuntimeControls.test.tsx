import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeState } from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { RuntimeControls } from "./RuntimeControls";

let client: ApiClient;
let state: RuntimeState;
beforeEach(() => {
  client = new ApiClient("test-token");
  state = {
    emergencyStopped: false,
    terminalSupported: true,
    executionEnvironment: "container",
    activeRuns: [],
    approvals: [
      {
        id: "approval",
        runId: "run",
        toolCallId: "tool",
        command: '{"command":"rm","args":["/data/test-marker"]}',
        status: "pending",
        createdAt: "now",
        resolvedAt: null,
      },
    ],
  };
  vi.spyOn(client, "runtime").mockImplementation(async () => state);
  vi.spyOn(client, "decideApproval").mockImplementation(async () => {
    state = { ...state, approvals: [] };
  });
  vi.spyOn(client, "emergencyStop").mockImplementation(async () => {
    state = { ...state, emergencyStopped: true, approvals: [] };
  });
  vi.spyOn(client, "resumeRuntime").mockImplementation(async () => {
    state = { ...state, emergencyStopped: false };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("runtime controls", () => {
  it("shows the exact command and container boundary before approving", async () => {
    render(<RuntimeControls client={client} onStoppedChange={() => {}} onError={() => {}} />);
    expect(await screen.findByRole("region", { name: "Command approval" })).toHaveTextContent(
      "/data/test-marker",
    );
    expect(screen.getByText(/inside the backend container/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve command" }));
    await waitFor(() => expect(client.decideApproval).toHaveBeenCalledWith("approval", true));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Command approval" })).not.toBeInTheDocument(),
    );
  });
  it("can deny a command and latch or resume emergency stop", async () => {
    const stopped = vi.fn();
    render(<RuntimeControls client={client} onStoppedChange={stopped} onError={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny command" }));
    await waitFor(() => expect(client.decideApproval).toHaveBeenCalledWith("approval", false));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Emergency stop" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Emergency stop" }));
    await screen.findByText(/Emergency stop active/);
    expect(stopped).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Resume execution" }));
    await waitFor(() => expect(client.resumeRuntime).toHaveBeenCalled());
    await waitFor(() => expect(stopped).toHaveBeenLastCalledWith(false));
  });
});
