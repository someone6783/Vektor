import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Profile } from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { SettingsView } from "./SettingsView";
vi.mock("./HealthCard", () => ({ HealthCard: () => null }));
vi.mock("./AboutView", () => ({ AboutView: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("saves explicit app grants, budgets and screenshot retention", async () => {
  const profile: Profile = {
    id: "p",
    name: "Desktop",
    color: "sky",
    systemPrompt: "",
    model: "test",
    temperature: 0.7,
    maxTokens: 2048,
    terminalMode: "no-terminal",
    tools: [],
    createdAt: "now",
    updatedAt: "now",
    archivedAt: null,
  };
  const client = new ApiClient("test");
  const save = vi.spyOn(client, "updateProfile").mockResolvedValue(profile);
  const error = vi.fn();
  render(
    <SettingsView
      client={client}
      profiles={[profile]}
      settings={{
        openRouterConfigured: false,
        openRouterSource: "none",
        defaultModel: "test",
        models: [],
        modelsFetchedAt: null,
      }}
      onSettingsChange={() => {}}
      onProfilesChange={async () => {}}
      onError={error}
    />,
  );
  fireEvent.change(screen.getByLabelText("Computer access for Desktop"), {
    target: { value: "control" },
  });
  fireEvent.change(screen.getByLabelText("Computer application command for Desktop"), {
    target: { value: "/usr/bin/xmessage" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add allowed application" }));
  fireEvent.change(screen.getByLabelText("Additional application 2 command"), {
    target: { value: "/usr/bin/xmessage" },
  });
  fireEvent.change(screen.getByLabelText("Computer action limit for Desktop"), {
    target: { value: "12" },
  });
  fireEvent.change(screen.getByLabelText("Computer time limit for Desktop"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("Computer screenshot retention for Desktop"), {
    target: { value: "0" },
  });
  fireEvent.click(screen.getByLabelText(/I understand the agent can see and control/));
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(error).not.toHaveBeenCalled();
  expect(save.mock.calls[0]?.[1].computer).toMatchObject({
    mode: "control",
    maxActions: 12,
    maxDurationMs: 120000,
    artifactDays: 0,
  });
  expect(save.mock.calls[0]?.[1].computer?.apps).toHaveLength(2);
});
