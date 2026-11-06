import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
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
vi.mock("./MessageActivity", () => ({
  MessageActivity: ({ content }: { content: string }) => <p>{content}</p>,
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
  vi.spyOn(client, "listRunnerModels").mockResolvedValue({
    models: [{ id: "codex-model", name: "Codex model" }],
    defaultModel: "codex-model",
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
  expect(screen.getByLabelText("Conversation model")).toBeInTheDocument();
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
  expect(settings.mock.calls).toEqual([["terminal", "native"], ["browser"]]);
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
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(create).toHaveBeenCalledWith("New conversation 3", "dm");
  await waitFor(() => expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled());
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
    fireEvent.click(screen.getByLabelText("Terminal access"));
    fireEvent.click(
      screen.getByRole("option", {
        name: terminalMode === "basic" ? "Workspace commands" : "Full Unrestricted · no approvals",
      }),
    );
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
  fireEvent.click(screen.getByLabelText("Browser access"));
  fireEvent.click(screen.getByRole("option", { name: "Observe" }));
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

it("keeps context closed by default and closes it when a wide workspace becomes narrow", () => {
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
  expect(context).toHaveAttribute("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Show context" }));
  expect(context).not.toHaveAttribute("hidden");
  act(() => {
    media.matches = false;
    media.dispatchEvent(new Event("change"));
  });
  expect(context).toHaveAttribute("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Show context" }));
  expect(context).not.toHaveAttribute("hidden");
});

it("uses the OpenCode default on runner switch and restores each runner's chosen model", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "runnerSetup").mockResolvedValue({
    installations: [
      {
        id: "acp:opencode",
        name: "OpenCode",
        enabled: true,
        version: "2.2.5",
        interface: "acp-v1",
        command: "/fixture/opencode",
        args: ["acp"],
        executableHash: "a".repeat(64),
        source: "fixture",
        sourceHash: "a".repeat(64),
        verifiedAt: "2026-11-03T00:00:00Z",
        inferenceHosts: ["opencode.ai"],
        credentialName: "OPENAI_API_KEY",
        credentialConfigured: false,
        authKind: "native-account",
      },
    ],
    probes: [],
    grants: [],
    registry: null,
  });
  vi.spyOn(client, "listModels").mockResolvedValue([
    { id: "openrouter/original-model", name: "Original" },
  ]);
  vi.spyOn(client, "listRunnerModels").mockResolvedValue({
    models: [
      { id: "opencode/free-default", name: "Free default" },
      { id: "opencode/free-choice", name: "Free choice" },
    ],
    defaultModel: "opencode/free-default",
  });
  const change = vi.fn();
  function Chat() {
    const [model, setModel] = useState("openrouter/original-model");
    return (
      <ChatView
        client={client}
        channel={channel}
        profile={{ ...profile, model }}
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
        onModelChange={(value) => {
          change(value);
          setModel(value);
        }}
      />
    );
  }
  render(<Chat />);
  await waitFor(() => expect(client.runnerSetup).toHaveBeenCalled());
  const picker = screen.getByLabelText("Runner for this message");
  fireEvent.click(picker);
  fireEvent.click(await screen.findByRole("option", { name: "OpenCode · enabled" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Conversation model")).toHaveTextContent("Free default"),
  );
  const modelMenu = screen.getByLabelText("Conversation model").closest("details")!;
  modelMenu.open = true;
  fireEvent(modelMenu, new Event("toggle"));
  fireEvent.click(screen.getByRole("option", { name: /Free choice/ }));
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("option", { name: "Profile runner · native" }));
  expect(change).toHaveBeenLastCalledWith("openrouter/original-model");
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("option", { name: "OpenCode · enabled" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Conversation model")).toHaveTextContent("Free choice"),
  );
});

it("regenerates the selected assistant response from its message", () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "runnerSetup").mockResolvedValue({
    installations: [],
    probes: [],
    grants: [],
    registry: null,
  });
  const retry = vi.fn();
  const messages = ["first", "second"].map((id) => ({
    id,
    channelId: channel.id,
    role: "assistant" as const,
    content: `${id} response`,
    status: "complete" as const,
    runId: `${id}-run`,
    createdAt: "now",
    attachments: [],
  }));
  const { rerender } = render(
    <ChatView
      client={client}
      channel={channel}
      profile={profile}
      lastRun={null}
      messages={messages}
      live={null}
      loading={false}
      loadingMore={false}
      hasMore={false}
      error={null}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={retry}
      onLoadMore={vi.fn()}
    />,
  );
  const buttons = screen.getAllByRole("button", { name: "Regenerate" });
  expect(buttons[0]!.parentElement?.parentElement).toHaveTextContent("first response");
  expect(buttons[1]!.parentElement?.parentElement).toHaveTextContent("second response");
  fireEvent.click(buttons[0]!);
  fireEvent.click(buttons[1]!);
  expect(retry.mock.calls).toEqual([["first-run"], ["second-run"]]);
  expect(screen.getByTestId("composer-controls")).not.toContainElement(buttons[0]!);
  rerender(
    <ChatView
      client={client}
      channel={channel}
      profile={profile}
      lastRun={null}
      messages={messages}
      live={null}
      loading={false}
      loadingMore={false}
      hasMore={false}
      error={null}
      emergencyStopped
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={retry}
      onLoadMore={vi.fn()}
    />,
  );
  screen
    .getAllByRole("button", { name: "Regenerate" })
    .forEach((button) => expect(button).toBeDisabled());
});

it("puts chats first, filters conversations, and creates chats independently of the search", async () => {
  const create = vi.fn().mockResolvedValue(undefined);
  const select = vi.fn();
  render(
    <Sidebar
      channels={[
        channel,
        {
          ...channel,
          id: "older",
          kind: "dm",
          name: "New conversation 7",
          updatedAt: "2026-11-01",
        },
        { ...channel, id: "newer", kind: "dm", name: "Trip planning", updatedAt: "2026-11-04" },
      ]}
      activeChannelId="newer"
      onSelect={select}
      onCreate={create}
      onRename={vi.fn()}
      onArchive={vi.fn()}
    />,
  );
  const navigation = screen.getByRole("navigation", { name: "Conversations" });
  const chats = within(navigation).getAllByRole("button", {
    name: /Trip planning|New conversation/,
  });
  expect(chats[0]).toHaveTextContent("Trip planning");
  expect(screen.getByText("Channels").closest("details")).not.toHaveAttribute("open");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search conversations" }), {
    target: { value: "general" },
  });
  expect(screen.queryByRole("button", { name: "Trip planning" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /General/ }));
  expect(select).toHaveBeenCalledWith(channel.id);
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("New conversation 8", "dm"));
});
