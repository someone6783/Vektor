import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile, Run } from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { RunTimeline } from "./RunTimeline";
import { AuditView } from "./AuditView";
import { SettingsView } from "./SettingsView";

vi.mock("./HealthCard", () => ({ HealthCard: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const run: Run = {
  id: "run",
  channelId: "channel",
  profileId: "profile",
  userMessageId: "message",
  model: "test",
  runner: "native",
  status: "completed",
  error: null,
  usage: null,
  context: null,
  terminalMode: "basic",
  startedAt: "2026-10-31T10:00:00Z",
  endedAt: "2026-10-31T10:00:01Z",
};
const profile: Profile = {
  id: "profile",
  name: "Default",
  color: "emerald",
  model: "test",
  systemPrompt: "",
  terminalMode: "no-terminal",
  tools: [],
  temperature: 0.7,
  maxTokens: 2048,
  createdAt: "now",
  updatedAt: "now",
  archivedAt: null,
};

describe("runtime history and permissions UI", () => {
  it("shows persisted tool input/output and allows retry from the run timeline", async () => {
    const client = new ApiClient("test");
    const retry = vi.fn();
    vi.spyOn(client, "listRuns").mockResolvedValue({ runs: [run], nextBefore: null });
    vi.spyOn(client, "runDetails").mockResolvedValue({
      run,
      approvals: [],
      tools: [
        {
          id: "tool",
          runId: "run",
          providerCallId: "call",
          name: "terminal",
          input: { command: "pwd" },
          output: "/data/workspace",
          status: "completed",
          createdAt: "now",
          endedAt: "now",
        },
      ],
      events: [{ runId: "run", seq: 1, type: "run.completed" }],
    });
    render(<RunTimeline client={client} channelId="channel" version={0} onRetry={retry} />);
    await waitFor(() => expect(client.runDetails).toHaveBeenCalledWith("run"));
    fireEvent.click(screen.getByText("Run timeline and tool calls"));
    fireEvent.click(await screen.findByText("terminal · completed"));
    expect(screen.getByText("/data/workspace")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry this run" }));
    expect(retry).toHaveBeenCalledWith("run");
  });

  it("paginates the durable audit log", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "audit").mockImplementation(async (before) => ({
      entries: [
        {
          id: before ? 1 : 2,
          action: before ? "approval.requested" : "approval.approved",
          runId: "run",
          details: { toolCallId: "tool" },
          createdAt: run.startedAt,
        },
      ],
      nextBefore: before ? null : 2,
    }));
    render(<AuditView client={client} />);
    await screen.findByText(/approval.approved/);
    fireEvent.click(screen.getByRole("button", { name: "Earlier audit entries" }));
    await screen.findByText(/approval.requested/);
    expect(client.audit).toHaveBeenCalledWith(2);
  });

  it.each(["full-access", "full-unrestricted"] as const)(
    "persists %s and the terminal tool switch",
    async (terminalMode) => {
      const client = new ApiClient("test");
      vi.spyOn(client, "updateProfile").mockResolvedValue({
        ...profile,
        terminalMode,
        tools: ["terminal"],
      });
      render(
        <SettingsView
          client={client}
          settings={{
            openRouterConfigured: false,
            openRouterSource: "none",
            defaultModel: "test",
            models: [],
            modelsFetchedAt: null,
          }}
          profiles={[profile]}
          onSettingsChange={() => {}}
          onProfilesChange={async () => {}}
          onError={() => {}}
        />,
      );
      fireEvent.change(screen.getByRole("combobox", { name: "Terminal mode for Default" }), {
        target: { value: terminalMode },
      });
      if (terminalMode === "full-access") {
        expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
        fireEvent.click(screen.getByRole("checkbox", { name: /I understand full access/ }));
      }
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      await waitFor(() =>
        expect(client.updateProfile).toHaveBeenCalledWith(
          "profile",
          expect.objectContaining({ terminalMode, tools: ["terminal"] }),
        ),
      );
    },
  );
});
