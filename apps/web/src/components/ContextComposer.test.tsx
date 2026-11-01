import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment, Channel, ContextEstimate, Profile } from "@vektor/shared";
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

function setup(activeRunCount = 0) {
  return render(
    <ContextComposer
      activeRunCount={activeRunCount}
      client={client}
      channel={channel}
      profile={profile}
      busy={false}
      historyVersion={0}
      lastRun={null}
      onSend={onSend}
      onStop={() => {}}
      onRetry={() => {}}
      canRetry={false}
    />,
  );
}

describe("context composer", () => {
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
          onRetry={() => {}}
          canRetry={false}
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
        within(inspector).getByRole("meter", { name: "Inspector context budget" }),
      ).toHaveValue(2068);
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Use only the PDF");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(onSend).toHaveBeenCalledWith("Use only the PDF", ["pdf"], false));
    } finally {
      cleanup();
      inspector.remove();
    }
  });

  it("opens context details from the bottom bar and dismisses them without losing the draft", async () => {
    setup(3);
    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(message, { target: { value: "Keep typing here" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    const footer = screen.getByRole("contentinfo", { name: "Conversation status" });
    expect(within(footer).getByText("3 active runs")).toBeInTheDocument();
    expect(within(footer).getByText("2 files")).toBeInTheDocument();
    const context = within(footer).getByLabelText("Context usage");
    const menu = context.closest("details")!;
    expect(menu).not.toHaveAttribute("open");
    fireEvent.click(context);
    expect(menu).toHaveAttribute("open");
    expect(within(footer).getByRole("meter", { name: "Context budget" })).toHaveValue(2068);
    fireEvent.keyDown(context, { key: "Escape" });
    expect(menu).not.toHaveAttribute("open");
    expect(context).toHaveFocus();
    fireEvent.click(context);
    fireEvent.pointerDown(message);
    expect(menu).not.toHaveAttribute("open");
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
    expect(client.estimateContext).toHaveBeenLastCalledWith(
      "channel",
      expect.objectContaining({ content: "Summarize", attachmentIds: ["pdf"] }),
    );
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

  it("requires confirmation when history will be omitted and prevents over-budget sends", async () => {
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
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Question", ["pdf", "image"], true));
    view.unmount();
    vi.mocked(client.estimateContext).mockResolvedValue({ ...estimate, exceedsBudget: true });
    setup();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Too much context" } });
    await screen.findByText(/Context is too large/);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
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
