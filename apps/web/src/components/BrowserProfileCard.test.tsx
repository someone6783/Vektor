import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { BrowserProfileCard } from "./BrowserProfileCard";
import { SettingsView } from "./SettingsView";

vi.mock("./HealthCard", () => ({ HealthCard: () => null }));
vi.mock("./AboutView", () => ({ AboutView: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const profile: Profile = {
  id: "profile",
  name: "Browser test",
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
describe("browser profile selection", () => {
  it("offers a saved default for observation and fully separate interactive sessions", async () => {
    const client = new ApiClient("test");
    const save = vi.spyOn(client, "updateProfile").mockResolvedValue(profile);
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
        onError={() => {}}
      />,
    );
    const mode = screen.getByLabelText("Browser access for Browser test");
    fireEvent.change(mode, { target: { value: "observe" } });
    const choice = screen.getByLabelText("Browser profile for Browser test");
    expect(choice).toHaveValue("default");
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        "profile",
        expect.objectContaining({
          browser: expect.objectContaining({ mode: "observe", session: "default" }),
        }),
      ),
    );
    fireEvent.change(mode, { target: { value: "interactive" } });
    fireEvent.change(choice, { target: { value: "separate" } });
    fireEvent.change(screen.getByLabelText("Browser window for Browser test"), {
      target: { value: "window" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        "profile",
        expect.objectContaining({
          browser: expect.objectContaining({
            mode: "interactive",
            session: "separate",
            display: "window",
          }),
        }),
      ),
    );
  });
  it("refreshes, disconnects and confirms reset without displaying credential contents", async () => {
    const client = new ApiClient("test");
    const info = {
      configured: true,
      inUse: true,
      runId: "run-default",
      savedAt: "2026-11-01T00:00:00Z",
      error: null,
    } as const;
    vi.spyOn(client, "defaultBrowserProfile").mockResolvedValue(info);
    const control = vi
      .spyOn(client, "controlDefaultBrowserProfile")
      .mockResolvedValue({ ...info, inUse: false, runId: null });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<BrowserProfileCard client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh profile status" }));
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect default profile" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith("disconnect"));
    fireEvent.click(screen.getByRole("button", { name: "Reset saved browser profile" }));
    expect(control).not.toHaveBeenCalledWith("reset");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Reset saved browser profile" }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith("reset"));
  });
});
