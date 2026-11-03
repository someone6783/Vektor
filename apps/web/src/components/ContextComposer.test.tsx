import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Attachment,
  Channel,
  ContextEstimate,
  Profile,
  Run,
  RunnerContext,
} from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { ContextComposer } from "./ContextComposer";

const channel: Channel = {
  id: "channel",
  name: "Files",
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
  model: "test-model",
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: 2048,
  tools: [],
  terminalMode: "no-terminal",
  createdAt: "now",
  updatedAt: "now",
  archivedAt: null,
};
const pdf: Attachment = {
  id: "pdf",
  channelId: "channel",
  filename: "notes.pdf",
  mime: "application/pdf",
  kind: "document",
  included: true,
  textPreview: "PDF preview contents",
  size: 100,
  createdAt: "now",
};
const image: Attachment = {
  ...pdf,
  id: "image",
  filename: "pixel.png",
  mime: "image/png",
  kind: "image",
  textPreview: "",
  width: 1,
  height: 1,
};
const estimate: ContextEstimate = {
  model: "test-model",
  contextWindow: 8192,
  windowSource: "model",
  originalInputTokens: 20,
  inputTokens: 20,
  availableInputTokens: 6144,
  reservedOutputTokens: 2048,
  attachmentTokens: 10,
  selectedAttachments: 1,
  droppedMessages: 0,
  requiresTruncation: false,
  exceedsBudget: false,
  warnings: ["Estimated tokens"],
};
let client: ApiClient;
let onSend: ReturnType<typeof vi.fn>;

beforeEach(() => {
  client = new ApiClient("test-token");
  vi.spyOn(client, "listAttachments").mockResolvedValue({
    attachments: [pdf, image],
    limits: { maxFileBytes: 1000, channelFileBytes: 10000, maxFiles: 50 },
  });
  vi.spyOn(client, "estimateContext").mockResolvedValue(estimate);
  vi.spyOn(client, "updateAttachment").mockImplementation(async (id, included) => ({
    ...(id === pdf.id ? pdf : image),
    included,
  }));
  vi.spyOn(client, "uploadAttachment").mockImplementation(async (_channelId, file) => ({
    ...image,
    id: file.name,
    filename: file.name,
  }));
  vi.spyOn(client, "attachmentContent").mockResolvedValue(new Blob(["preview"]));
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  });
  onSend = vi.fn().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(activeRunCount = 0, busy = false, mcpToolbarTarget: HTMLElement | null = null) {
  return render(
    <ContextComposer
      mcpToolbarTarget={mcpToolbarTarget}
      activeRunCount={activeRunCount}
      client={client}
      channel={channel}
      profile={profile}
      busy={busy}
      historyVersion={0}
      lastRun={null}
      onSend={onSend}
      onStop={() => {}}
    />,
  );
}

describe("context composer", () => {
  it("accepts a message while another run is active without waiting for a context estimate", async () => {
    setup(1, true);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Do this next" },
    });
    expect(screen.getByRole("button", { name: "Queue" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Do this next", [], false));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("keeps the previous context budget visible while refreshing and accepts a message immediately", async () => {
    const inspector = document.createElement("div");
    document.body.append(inspector);
    try {
      render(
        <ContextComposer
          contextTarget={inspector}
          client={client}
          channel={channel}
          profile={profile}
          busy={false}
          historyVersion={0}
          lastRun={null}
          onSend={onSend}
          onStop={() => {}}
        />,
      );
      const meter = await within(inspector).findByRole("meter", {
        name: "Inspector context budget",
      });
      expect(meter).toHaveValue(2068);
      const usage = screen.getByLabelText("Context usage");
      const previousUsage = usage.textContent;
      let resolveRefresh!: (value: ContextEstimate) => void;
      vi.mocked(client.estimateContext).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
        target: { value: "A new draft" },
      });
      expect(meter).toHaveValue(2068);
      expect(usage.textContent).toBe(previousUsage);
      expect(within(inspector).queryByText("Estimating context…")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
      await waitFor(() => expect(resolveRefresh).toBeTypeOf("function"));
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
      await waitFor(() =>
        expect(onSend).toHaveBeenCalledWith("A new draft", ["pdf", "image"], false),
      );
      await act(async () => resolveRefresh({ ...estimate, inputTokens: 120 }));
      expect(meter).toHaveValue(2168);
    } finally {
      cleanup();
      inspector.remove();
    }
  });

  it("edits shared file context in the inspector without losing the composer draft", async () => {
    const inspector = document.createElement("div");
    document.body.append(inspector);
    try {
      render(
        <ContextComposer
          contextTarget={inspector}
          client={client}
          channel={channel}
          profile={profile}
          busy={false}
          historyVersion={0}
          lastRun={null}
          onSend={onSend}
          onStop={() => {}}
        />,
      );
      const checkbox = await within(inspector).findByRole("checkbox", {
        name: "Include pixel.png in context",
      });
      fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
        target: { value: "Use only the PDF" },
      });
      fireEvent.click(checkbox);
      await waitFor(() => expect(client.updateAttachment).toHaveBeenCalledWith("image", false));
      await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
      expect(
        await within(inspector).findByRole("meter", { name: "Inspector context budget" }),
      ).toHaveValue(2068);
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Use only the PDF");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(onSend).toHaveBeenCalledWith("Use only the PDF", ["pdf"], false));
    } finally {
      cleanup();
      inspector.remove();
    }
  });

  it("shows context usage as a plain status without a duplicate menu", async () => {
    setup(3);
    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(message, { target: { value: "Keep typing here" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    const footer = screen.getByRole("contentinfo", { name: "Conversation status" });
    expect(within(footer).getByText("3 active runs")).toBeInTheDocument();
    expect(within(footer).getByText("2 files")).toBeInTheDocument();
    const context = within(footer).getByLabelText("Context usage");
    expect(context.closest("details")).toBeNull();
    expect(context).not.toHaveAttribute("tabindex");
    expect(within(footer).queryByRole("meter")).not.toBeInTheDocument();
    fireEvent.click(context);
    expect(screen.queryByText("Estimated input:", { exact: false })).not.toBeInTheDocument();
    expect(message).toHaveValue("Keep typing here");
  });

  it("opens the file picker from the accessible plus button", async () => {
    setup();
    await screen.findByRole("checkbox", { name: "Include pixel.png in context" });
    const picker = vi.spyOn(screen.getByLabelText("Upload attachments"), "click");
    const attach = screen.getByRole("button", { name: "Attach files" });
    expect(attach).toHaveTextContent("");
    fireEvent.click(attach);
    expect(picker).toHaveBeenCalledOnce();
  });

  it("excludes an image, previews extracted PDF text, and sends only the selected PDF", async () => {
    setup();
    await screen.findByRole("checkbox", { name: "Include pixel.png in context" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include pixel.png in context" }));
    await waitFor(() => expect(client.updateAttachment).toHaveBeenCalledWith("image", false));
    fireEvent.click(screen.getByLabelText("Actions for notes.pdf"));
    fireEvent.click(screen.getByRole("button", { name: "Preview notes.pdf" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("PDF preview contents");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Summarize" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Summarize", ["pdf"], false));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(""));
  });

  it("uploads images from paste and files from drag/drop and the file picker", async () => {
    setup();
    await screen.findByRole("checkbox", { name: "Include pixel.png in context" });
    const pasted = new File(["png"], "pasted.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => pasted }] },
    });
    await screen.findByRole("checkbox", { name: "Include pasted.png in context" });
    const dropped = new File(["text"], "dropped.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: { files: [dropped] } });
    await screen.findByRole("checkbox", { name: "Include dropped.txt in context" });
    const selected = new File(["text"], "selected.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Upload attachments"), {
      target: { files: [selected] },
    });
    await screen.findByRole("checkbox", { name: "Include selected.txt in context" });
    expect(client.uploadAttachment).toHaveBeenCalledTimes(3);
  });

  it("passes explicit truncation consent to the queue and allows queuing over-budget drafts", async () => {
    vi.mocked(client.estimateContext).mockResolvedValue({
      ...estimate,
      requiresTruncation: true,
      droppedMessages: 2,
    });
    const view = setup();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Question" } });
    const confirmation = await screen.findByRole("checkbox", {
      name: "Omit 2 oldest messages for this run",
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Question", ["pdf", "image"], true));
    view.unmount();
    vi.mocked(client.estimateContext).mockResolvedValue({ ...estimate, exceedsBudget: true });
    setup();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Too much context" } });
    await screen.findByText(/Context is too large/);
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(onSend).toHaveBeenLastCalledWith("Too much context", ["pdf", "image"], false),
    );
  });

  it("preserves the draft on send failure and revokes image preview URLs", async () => {
    onSend.mockRejectedValue(new Error("Provider unavailable"));
    setup();
    await screen.findByRole("checkbox", { name: "Include pixel.png in context" });
    fireEvent.click(screen.getByLabelText("Actions for pixel.png"));
    fireEvent.click(screen.getByRole("button", { name: "Preview pixel.png" }));
    await screen.findByRole("img", { name: "pixel.png" });
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep my draft" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Provider unavailable");
    expect(screen.getByRole("textbox")).toHaveValue("Keep my draft");
  });

  it("ignores stale estimates when a newer draft is entered", async () => {
    let resolveOld: (value: ContextEstimate) => void = () => {};
    vi.mocked(client.estimateContext).mockImplementation(async (_channelId, input) =>
      input.content === "old"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : estimate,
    );
    setup();
    await screen.findByRole("checkbox", { name: "Include pixel.png in context" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "old" } });
    await waitFor(() =>
      expect(client.estimateContext).toHaveBeenCalledWith(
        "channel",
        expect.objectContaining({ content: "old" }),
      ),
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    await act(async () => resolveOld({ ...estimate, exceedsBudget: true }));
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});

it("previews prepared MCP context and sends only explicitly selected items", async () => {
  const source = {
    id: "00000000-0000-4000-8000-000000000001",
    serverId: "00000000-0000-4000-8000-000000000002",
    profileId: profile.id,
    revision: 1,
    kind: "resource" as const,
    name: "fixture://notes",
    createdAt: "2026-11-02",
    preview: "Prepared notes",
    size: 100,
  };
  const load = vi.spyOn(client, "mcpContexts").mockResolvedValue([source]),
    preview = vi
      .spyOn(client, "mcpContext")
      .mockResolvedValue({ text: "Explicit untrusted MCP text" });
  const toolbar = document.createElement("div");
  document.body.append(toolbar);
  setup(0, false, toolbar);
  const trigger = screen.getByLabelText("MCP context");
  expect(toolbar).toContainElement(trigger);
  fireEvent.click(trigger);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Load prepared MCP context" }));
  const selection = await screen.findByLabelText(/resource: fixture:\/\/notes/);
  expect(selection).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await screen.findByText("Explicit untrusted MCP text");
  expect(preview).toHaveBeenCalledWith(source.id);
  fireEvent.click(selection);
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Use selected MCP context" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(onSend).toHaveBeenCalledWith("Use selected MCP context", [pdf.id, image.id], false, [
      source.id,
    ]),
  );
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(trigger.closest("details")).not.toHaveAttribute("open");
  toolbar.remove();
});

describe("Codex context reporting", () => {
  const context: RunnerContext = {
    inputTokens: 2000,
    outputTokens: 10,
    totalTokens: 2010,
    contextWindow: 272000,
  };
  const run: Run = {
    id: "codex-run",
    channelId: channel.id,
    profileId: profile.id,
    userMessageId: "message",
    model: profile.model,
    runner: "codex",
    status: "completed",
    error: null,
    usage: { promptTokens: 10000, completionTokens: 50, totalTokens: 10050 },
    context: null,
    terminalMode: "full-access",
    startedAt: "now",
    endedAt: "now",
    harness: {
      contractVersion: 1,
      interface: "codex-app-server",
      agentVersion: "0.166.0",
      executableHash: "verified",
      cursor: 1,
      state: "completed",
      metricsAvailable: true,
      context,
    },
  };
  function renderCodex(lastRun: Run | null = null, runtimeContext?: RunnerContext) {
    const target = document.createElement("div");
    document.body.append(target);
    const props = {
      client,
      channel,
      profile: { ...profile, runner: "codex" as const },
      busy: false,
      historyVersion: 0,
      lastRun,
      runtimeContext,
      onSend,
      onStop: vi.fn(),

      contextTarget: target,
    };
    const view = render(<ContextComposer {...props} />);
    return { target, props, ...view };
  }
  it("hides the misleading 8,192-token fallback and percentage for legacy Codex estimates", async () => {
    vi.mocked(client.estimateContext).mockResolvedValue({
      ...estimate,
      windowSource: "fallback",
      warnings: ["Context limit unknown; using 8,192 tokens."],
    });
    const { target } = renderCodex();
    await waitFor(() =>
      expect(within(target).getByText(/context limit unknown/)).toBeInTheDocument(),
    );
    expect(within(target).queryByRole("meter")).not.toBeInTheDocument();
    expect(within(target).queryByText(/8,192/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Context usage")).toHaveTextContent("Context —");
    target.remove();
  });
  it("shows Codex's reported window and latest request while keeping cumulative usage separate", () => {
    const { target } = renderCodex(run);
    expect(within(target).getByText("2,010 / 272,000 tokens")).toBeInTheDocument();
    expect(within(target).getByRole("meter")).toHaveAttribute("value", "2010");
    expect(within(target).getByText("2,000 input + 10 output")).toBeInTheDocument();
    expect(within(target).getByText("10,000 input + 50 output tokens")).toBeInTheDocument();
    expect(screen.getByLabelText("Context usage")).toHaveTextContent("Context 1%");
    target.remove();
  });
  it("updates live context after compaction and ignores reports for a different model", async () => {
    const { target, props, rerender } = renderCodex(run);
    rerender(
      <ContextComposer
        {...props}
        runtimeContext={{ ...context, inputTokens: 1000, totalTokens: 1010 }}
      />,
    );
    expect(within(target).getByText("1,010 / 272,000 tokens")).toBeInTheDocument();
    rerender(
      <ContextComposer
        {...props}
        profile={{ ...props.profile, model: "different-codex-model" }}
        runtimeContext={context}
      />,
    );
    await waitFor(() => expect(within(target).queryByRole("meter")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Context usage")).toHaveTextContent("Context —");
    target.remove();
  });
});
