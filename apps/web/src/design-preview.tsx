// Standalone preview of the production components. All data and actions stay in memory.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Attachment, Channel, ContextEstimate, Message, Profile, Run } from "@vektor/shared";
import { ChatView } from "./components/ChatView";
import { Sidebar } from "./components/Sidebar";
import { OverflowMenu } from "./components/OverflowMenu";
import { ThemePicker } from "./components/ThemePicker";
import { ApiClient } from "./lib/api";
import { applyTheme, readTheme } from "./lib/theme";
import "./index.css";

const timestamp = "2026-11-01T02:42:00Z";
const profile: Profile = {
  id: "preview-profile",
  name: "Research assistant",
  model: "research-model",
  color: "sky",
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: 4096,
  terminalMode: "basic",
  tools: ["terminal"],
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
};
const initialChannels: Channel[] = ["research", "general", "product", "Ada"].map((name) => ({
  id: name,
  name,
  kind: name === "Ada" ? "dm" : "channel",
  topic: "Notes, ideas and the next useful step",
  profileId: profile.id,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
}));
let files: Attachment[] = ["research-notes.md", "product-brief.md"].map((filename, index) => ({
  id: `file-${index}`,
  channelId: "research",
  filename,
  mime: "text/markdown",
  kind: "text",
  size: 1600 + index * 640,
  included: true,
  textPreview:
    "Keep the conversation central. Separate context from writing. Make every action readable.",
  createdAt: timestamp,
}));
const context: ContextEstimate = {
  model: "research-model",
  contextWindow: 128000,
  windowSource: "model",
  inputTokens: 18944,
  originalInputTokens: 18944,
  reservedOutputTokens: 4096,
  availableInputTokens: 123904,
  attachmentTokens: 1920,
  selectedAttachments: 2,
  droppedMessages: 0,
  requiresTruncation: false,
  exceedsBudget: false,
  warnings: [],
};
const run: Run = {
  id: "preview-run",
  channelId: "research",
  profileId: profile.id,
  userMessageId: "first",
  model: profile.model,
  runner: "native",
  status: "completed",
  error: null,
  usage: { promptTokens: 18944, completionTokens: 480, totalTokens: 19424 },
  context,
  terminalMode: "basic",
  startedAt: timestamp,
  endedAt: timestamp,
};
const client = new ApiClient("preview-only");
client.listAttachments = async () => ({
  attachments: [...files],
  limits: { maxFileBytes: 25000000, channelFileBytes: 250000000, maxFiles: 50 },
});
client.updateAttachment = async (id, included) => {
  files = files.map((file) => (file.id === id ? { ...file, included } : file));
  return files.find((file) => file.id === id)!;
};
client.deleteAttachment = async (id) => {
  files = files.filter((file) => file.id !== id);
};
client.attachmentContent = async (id) =>
  new Blob([files.find((file) => file.id === id)?.textPreview ?? ""], { type: "text/plain" });
client.uploadAttachment = async (channelId, file) => {
  const attachment: Attachment = {
    id: crypto.randomUUID(),
    channelId,
    filename: file.name,
    mime: file.type || "text/plain",
    kind: "text",
    size: file.size,
    included: true,
    textPreview: "Local preview attachment. No upload was performed.",
    createdAt: timestamp,
  };
  files.push(attachment);
  return attachment;
};
client.estimateContext = async (_id, request) => {
  const inputTokens =
    17024 +
    (request.attachmentIds?.length ?? 0) * 960 +
    Math.ceil((request.content?.length ?? 0) / 4);
  return {
    ...context,
    inputTokens,
    originalInputTokens: inputTokens,
    selectedAttachments: request.attachmentIds?.length ?? 0,
  };
};
client.listRuns = async (channelId) => ({
  runs: channelId === "research" ? [run] : [],
  nextBefore: null,
});
client.runDetails = async () => ({
  run,
  approvals: [],
  events: [],
  tools: [
    {
      id: "preview-tool",
      runId: run.id,
      providerCallId: "call",
      name: "terminal",
      input: { command: "ls", args: ["./research"] },
      output: "research-notes.md\nproduct-brief.md",
      status: "completed",
      createdAt: timestamp,
      endedAt: timestamp,
    },
  ],
});

const initialMessages: Message[] = [
  {
    id: "first",
    channelId: "research",
    role: "user",
    content: "Review the research notes and suggest three practical ways to improve the workspace.",
    status: "complete",
    runId: run.id,
    createdAt: timestamp,
    attachments: [],
  },
  {
    id: "second",
    channelId: "research",
    role: "assistant",
    content:
      "### A clearer view of what’s next.\n\nThe notes point to one priority: make the everyday workflow easier to scan.\n\n**01 · Give the conversation room.**\n\nA bounded reading column keeps long answers comfortable on a wide display. The composer follows the same width.\n\n**02 · Put context beside the work.**\n\nFiles, token budget and run details live in the right-hand inspector. A compact context strip stays above the prompt.\n\n**03 · Make every action clear.**\n\nGenerous buttons, visible focus and stronger secondary text make the workspace easier to use.\n\nSwitch between **Orbit** and **Beacon** above. The structure and spacing stay the same.",
    status: "complete",
    runId: run.id,
    createdAt: timestamp,
    attachments: [],
  },
];

function DesignPreview() {
  const [channels, setChannels] = useState(initialChannels);
  const [activeId, setActiveId] = useState("research");
  const [messages, setMessages] = useState(initialMessages);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const channel = channels.find((channel) => channel.id === activeId) ?? null;
  return (
    <div className="preview-shell">
      <div className="preview-caption">
        <span>Implemented workspace · Interactive sample data</span>
        <span>Orbit structure + Beacon spacing</span>
      </div>
      <div className="app-shell preview-app flex flex-col overflow-hidden bg-slate-950 text-slate-100">
        <header className="app-header flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 bg-slate-900 px-4 py-3">
          <button
            className="sidebar-toggle"
            aria-label="Toggle conversations"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            ☰
          </button>
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent-400 text-sm font-bold text-slate-950">
              V
            </div>
            <strong className="text-sm">Vektor</strong>
          </div>
          <span className="text-xs text-slate-400">Personal workspace</span>
          <div className="ml-auto flex items-center gap-3">
            <OverflowMenu label="Workspace actions">
              <div className="menu-label">Appearance</div>
              <ThemePicker />
            </OverflowMenu>
            <span className="text-xs text-emerald-300">● Local preview</span>
          </div>
        </header>
        <div className="workspace-body flex min-h-0 flex-1" data-sidebar-open={sidebarOpen}>
          <Sidebar
            channels={channels}
            activeChannelId={activeId}
            onSelect={(id) => {
              setActiveId(id);
              setSidebarOpen(false);
            }}
            onCreate={async (name, kind) => {
              const newChannel = { ...initialChannels[0]!, id: crypto.randomUUID(), name, kind };
              setChannels((channels) => [...channels, newChannel]);
              setActiveId(newChannel.id);
              setSidebarOpen(false);
            }}
            onRename={async (id, name) =>
              setChannels((channels) =>
                channels.map((channel) => (channel.id === id ? { ...channel, name } : channel)),
              )
            }
            onArchive={async (id) => {
              setChannels((channels) => channels.filter((channel) => channel.id !== id));
              setActiveId(channels.find((channel) => channel.id !== id)?.id ?? "");
            }}
          />
          <ChatView
            key={activeId}
            client={client}
            channel={channel}
            profile={profile}
            messages={messages.filter((message) => message.channelId === activeId)}
            lastRun={activeId === "research" ? run : null}
            live={null}
            loading={false}
            loadingMore={false}
            hasMore={false}
            error={null}
            onLoadMore={() => {}}
            onStop={() => {}}
            onRetry={() => setNotice("Preview only: no provider request was made.")}
            onSend={async (content) => {
              const id = crypto.randomUUID();
              setMessages((messages) => [
                ...messages,
                { ...initialMessages[0]!, id, channelId: activeId, content },
                {
                  ...initialMessages[1]!,
                  id: id + "-answer",
                  channelId: activeId,
                  content:
                    "Your message is displayed using the production chat components. This preview uses sample data; no provider request was made.",
                },
              ]);
            }}
          />
        </div>
      </div>
      <p className="preview-footnote" role="status">
        {notice ||
          "Use the theme menu, context inspector, file toggles and composer. Preview actions stay on this device."}
      </p>
    </div>
  );
}

applyTheme(readTheme());
createRoot(document.getElementById("root")!).render(<DesignPreview />);
