import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Channel, Profile } from "@vektor/shared";
import { ChatView } from "./ChatView";
import { Sidebar } from "./Sidebar";
import { OverflowMenu } from "./OverflowMenu";
import { ConversationSettings } from "./ConversationSettings";
import { ApiClient } from "../lib/api";

vi.mock("./ContextComposer", () => ({
  ContextComposer: ({ modelControls }: { modelControls?: ReactNode }) => (
    <div data-testid="composer-controls">{modelControls}</div>
  ),
}));
vi.mock("./RunTimeline", () => ({ RunTimeline: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const channel: Channel = {
  id: "chat",
  name: "General",
  topic: "",
  kind: "channel",
  profileId: "profile",
  createdAt: "now",
  updatedAt: "now",
  archivedAt: null,
};
const profile: Profile = {
  id: "profile",
  name: "Default",
  color: "emerald",
  model: "current",
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: 2048,
  tools: [],
  terminalMode: "no-terminal",
  createdAt: "now",
  updatedAt: "now",
  archivedAt: null,
};

it("offers every available model and shortcuts to terminal and browser settings", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "listModels").mockResolvedValue([
    { id: "one", name: "One" },
    { id: "two", name: "Two" },
    { id: "remote", name: "Remote model" },
  ]);
  vi.spyOn(client, "runnerSetup").mockResolvedValue({
    installations: [],
    probes: [],
    grants: [],
    registry: null,
  });
  const change = vi.fn();
  const settings = vi.fn();
  render(
    <ChatView
      client={client}
      channel={channel}
      profile={profile}
      lastRun={null}
      messages={[]}
      live={null}
      loading={false}
      loadingMore={false}
      hasMore={false}
      error={null}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      onLoadMore={vi.fn()}
      models={[
        { id: "one", name: "One" },
        { id: "two", name: "Two" },
      ]}
      onModelChange={change}
      onExecutionSettings={settings}
    />,
  );
  const runner = screen.getByLabelText("Runner for this message");
  expect(runner.closest("header")).toContainElement(screen.getByLabelText("Terminal settings"));
  expect(screen.getByTestId("composer-controls")).not.toContainElement(runner);
  fireEvent.click(runner);
  fireEvent.click(screen.getByRole("option", { name: "Codex · this message" }));
  expect(screen.getByLabelText("External runner model")).toBeInTheDocument();
  fireEvent.click(runner);
  fireEvent.click(screen.getByRole("option", { name: "Profile runner · native" }));
  const picker = screen.getByLabelText("Conversation model").closest("details")!;
  expect(screen.getByTestId("composer-controls")).toContainElement(picker);
  picker.open = true;
  fireEvent(picker, new Event("toggle"));
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  fireEvent.click(screen.getByLabelText("Conversation model"));
  await screen.findByRole("option", { name: /Remote model/ });
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(4);
  fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), {
    target: { value: "remote" },
  });
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
  fireEvent.click(screen.getByRole("option", { name: /Remote model/ }));
  expect(change).toHaveBeenCalledWith("remote");
  fireEvent.click(screen.getByRole("button", { name: "Terminal settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Browser settings" }));
  expect(settings.mock.calls).toEqual([["terminal"], ["browser"]]);
});

it("creates a direct conversation immediately with an unused temporary name", async () => {
  const create = vi.fn().mockResolvedValue(undefined);
  render(
    <Sidebar
      channels={[{ ...channel, kind: "dm", name: "New conversation 2" }]}
      activeChannelId={null}
      onCreate={create}
      onSelect={vi.fn()}
      onRename={vi.fn()}
      onArchive={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByTitle("New direct conversation"));
  expect(create).toHaveBeenCalledWith("New conversation 3", "dm");
  await waitFor(() => expect(screen.getByTitle("New direct conversation")).toBeEnabled());
});

it("places a menu above a trigger near the viewport bottom and clamps its width", async () => {
  render(
    <OverflowMenu label="Actions">
      <button>Rename</button>
    </OverflowMenu>,
  );
  const trigger = screen.getByLabelText("Actions");
  const menu = trigger.closest("details")!;
  const panel = menu.querySelector("div")!;
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    top: 730,
    bottom: 762,
    right: 50,
  } as DOMRect);
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ width: 216, height: 100 } as DOMRect);
  Object.defineProperty(panel, "scrollHeight", { value: 100 });
  menu.open = true;
  fireEvent(menu, new Event("toggle"));
  expect(panel.style.position).toBe("fixed");
  expect(panel.style.left).toBe("8px");
  expect(panel.style.top).toBe("622px");
});

it.each(["basic", "full-unrestricted"])(
  "saves %s terminal permissions for the conversation and offers a direct way back",
  async (terminalMode) => {
    const save = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    render(
      <ConversationSettings
        channel={channel}
        profile={profile}
        section="terminal"
        onSave={save}
        onClose={close}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Terminal · General" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Terminal access"), { target: { value: terminalMode } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ terminalMode, sshConnectionId: null }));
    expect(profile.terminalMode).toBe("no-terminal");
    await waitFor(() => expect(close).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(close).toHaveBeenCalledTimes(2);
  },
);

it("saves browser permissions independently of terminal settings", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  render(
    <ConversationSettings
      channel={channel}
      profile={profile}
      section="browser"
      onSave={save}
      onClose={close}
    />,
  );
  fireEvent.change(screen.getByLabelText("Browser access"), { target: { value: "observe" } });
  fireEvent.change(screen.getByLabelText("Allowed website origins"), {
    target: { value: "https://example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      browser: {
        mode: "observe",
        session: "separate",
        display: "headless",
        allowedOrigins: ["https://example.com"],
        localOrigins: [],
      },
    }),
  );
});

it("keeps settled conversations at the bottom, opens their history and offers Restore", async () => {
  const select = vi.fn();
  const restore = vi.fn().mockResolvedValue(undefined);
  const archived = {
    ...channel,
    id: "settled",
    name: "Finished research",
    archivedAt: "2026-11-01T10:00:00Z",
  };
  const { container, rerender } = render(
    <Sidebar
      channels={[archived, channel]}
      activeChannelId={null}
      onSelect={select}
      onCreate={vi.fn()}
      onRename={vi.fn()}
      onArchive={vi.fn()}
      onRestore={restore}
    />,
  );
  const settled = screen.getByRole("region", { name: "Settled conversations" });
  expect(within(settled).getByRole("button", { name: /Finished research/ })).toBeInTheDocument();
  const navigation = screen.getByRole("navigation", { name: "Conversations" });
  expect(navigation.lastElementChild).toBe(settled);
  expect(container.querySelectorAll('[title="Finished research"]')).toHaveLength(1);
  fireEvent.click(within(settled).getByRole("button", { name: /Finished research/ }));
  expect(select).toHaveBeenCalledWith("settled");
  fireEvent.click(within(settled).getByLabelText("Actions for Finished research"));
  fireEvent.click(within(settled).getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("settled"));
  rerender(
    <Sidebar
      channels={[{ ...archived, archivedAt: null }, channel]}
      activeChannelId="settled"
      onSelect={select}
      onCreate={vi.fn()}
      onRename={vi.fn()}
      onArchive={vi.fn()}
      onRestore={restore}
    />,
  );
  expect(screen.queryByRole("region", { name: "Settled conversations" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Finished research/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

it("closes the context overlay when a wide workspace becomes narrow", () => {
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", () => media);
  render(
    <ChatView
      client={new ApiClient("test")}
      channel={channel}
      profile={profile}
      lastRun={null}
      messages={[]}
      live={null}
      loading={false}
      loadingMore={false}
      hasMore={false}
      error={null}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      onLoadMore={vi.fn()}
    />,
  );
  const context = screen.getByLabelText("Workspace context");
  expect(context).not.toHaveAttribute("hidden");
  act(() => {
    media.matches = false;
    media.dispatchEvent(new Event("change"));
  });
  expect(context).toHaveAttribute("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Show context" }));
  expect(context).not.toHaveAttribute("hidden");
});
