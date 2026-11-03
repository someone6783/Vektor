import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Channel, Profile } from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { ConversationSettings } from "./ConversationSettings";
afterEach(cleanup);
const channel = { id: "chat", name: "General", execution: {} } as Channel;
const profile = {
  id: "default",
  name: "Default",
  terminalMode: "no-terminal",
  tools: [],
  runner: "native",
} as unknown as Profile;
function setup(fail = false) {
  const order: string[] = [];
  const runnerGrant = vi.fn().mockImplementation(async () => {
    order.push("grant");
    if (fail) throw new Error("Could not save agent access.");
  });
  const onSave = vi.fn().mockImplementation(async () => {
    order.push("execution");
  });
  const onClose = vi.fn();
  const client = {
    sshList: vi.fn().mockResolvedValue([]),
    runnerSetup: vi.fn().mockResolvedValue({
      installations: [{ id: "codex", enabled: true }],
      grants: [{ profileId: profile.id, runner: "acp:opencode", workspace: true, inference: true }],
    }),
    runnerGrant,
  } as unknown as ApiClient;
  render(
    <ConversationSettings
      channel={channel}
      profile={profile}
      runner="codex"
      section="terminal"
      client={client}
      retryOnSave
      onSave={onSave}
      onClose={onClose}
    />,
  );
  return { runnerGrant, onSave, onClose, order };
}
it("requires explicit terminal, workspace and model consent before saving and retrying", async () => {
  const { runnerGrant, onSave, onClose, order } = setup();
  const save = screen.getByRole("button", { name: "Save and retry" });
  await waitFor(() => expect(screen.getByLabelText("Allow Codex workspace access")).toBeEnabled());
  expect(screen.getByLabelText("Terminal access")).toHaveTextContent("Off");
  expect(screen.getByLabelText("Allow Codex workspace access")).not.toBeChecked();
  expect(screen.getByLabelText("Allow Codex model requests")).not.toBeChecked();
  expect(save).toBeDisabled();
  expect(runnerGrant).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText("Terminal access"));
  fireEvent.click(screen.getByRole("option", { name: "Full access · approve each command" }));
  fireEvent.click(screen.getByLabelText("Allow Codex workspace access"));
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByLabelText("Allow Codex model requests"));
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(runnerGrant).toHaveBeenCalledWith(profile.id, {
    runner: "codex",
    workspace: true,
    inference: true,
  });
  expect(onSave).toHaveBeenCalledWith({ terminalMode: "full-access", sshConnectionId: null });
  expect(order).toEqual(["grant", "execution"]);
  expect(profile.terminalMode).toBe("no-terminal");
  expect(profile.tools).toEqual([]);
});
it("keeps the message blocked if agent grants cannot be saved", async () => {
  const { onSave, onClose } = setup(true);
  await waitFor(() => expect(screen.getByLabelText("Allow Codex workspace access")).toBeEnabled());
  fireEvent.click(screen.getByLabelText("Terminal access"));
  fireEvent.click(screen.getByRole("option", { name: "Full access · approve each command" }));
  fireEvent.click(screen.getByLabelText("Allow Codex workspace access"));
  fireEvent.click(screen.getByLabelText("Allow Codex model requests"));
  fireEvent.click(screen.getByRole("button", { name: "Save and retry" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save agent access.");
  expect(onSave).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
it("changes no permissions when review is cancelled", async () => {
  const { onSave, runnerGrant } = setup();
  await waitFor(() => expect(screen.getByLabelText("Allow Codex workspace access")).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
  expect(onSave).not.toHaveBeenCalled();
  expect(runnerGrant).not.toHaveBeenCalled();
});
