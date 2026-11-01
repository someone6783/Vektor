import { Icon } from "./Icon";
import { OverflowMenu } from "./OverflowMenu";
import { useState } from "react";
import { APP_VERSION, type Channel } from "@vektor/shared";

interface SidebarProps {
  channels: Channel[];
  activeChannelId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string, kind: "channel" | "dm") => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onRestore?: (id: string) => Promise<void>;
}

function ChannelRow({
  channel,
  active,
  onSelect,
  onRename,
  onArchive,
  onRestore,
}: {
  channel: Channel;
  active: boolean;
  onSelect: () => void;
  onRename: (name: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onRestore?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(channel.name);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const name = value.trim();
    if (!name || name === channel.name) {
      setEditing(false);
      setValue(channel.name);
      return;
    }

    setBusy(true);
    try {
      await onRename(name);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (
      !window.confirm(
        `Move "${channel.name}" to Settled? You can open or restore it from the bottom of the sidebar.`,
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      await onArchive();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      {editing ? (
        <form
          className="flex items-center gap-1 px-1"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void save()}
            className="min-w-0 flex-1 rounded-md border border-accent-400/40 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none"
          />
        </form>
      ) : (
        <div className={`channel-row ${active ? "channel-selected" : ""}`}>
          <button
            type="button"
            onClick={onSelect}
            aria-current={active ? "page" : undefined}
            title={channel.name}
            className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm transition ${
              active ? "font-medium" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <span className="channel-prefix" aria-hidden="true">
              {channel.kind === "dm" ? "@" : "#"}
            </span>
            <span className="channel-name">{channel.name}</span>
          </button>
          <OverflowMenu label={`Actions for ${channel.name}`}>
            <button
              type="button"
              onClick={() => {
                setValue(channel.name);
                setEditing(true);
              }}
              className="text-slate-200 hover:bg-white/5"
            >
              <Icon name="edit" /> Rename
            </button>
            {channel.archivedAt ? (
              <button
                type="button"
                onClick={() => void onRestore?.()}
                disabled={busy || !onRestore}
              >
                <Icon name="refresh" /> Restore
              </button>
            ) : (
              <button type="button" onClick={() => void archive()} disabled={busy}>
                <Icon name="archive" /> Settle
              </button>
            )}
          </OverflowMenu>
        </div>
      )}
    </li>
  );
}

export function Sidebar({
  channels,
  activeChannelId,
  onSelect,
  onCreate,
  onRename,
  onArchive,
  onRestore,
}: SidebarProps) {
  const [creating, setCreating] = useState<"channel" | "dm" | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const rooms = channels.filter((channel) => !channel.archivedAt && channel.kind === "channel");
  const dms = channels.filter((channel) => !channel.archivedAt && channel.kind === "dm");

  const settled = channels
    .filter((channel) => channel.archivedAt !== null)
    .sort((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));

  const submit = async () => {
    const name = draft.trim();
    if (!name || !creating) {
      return;
    }

    setBusy(true);
    try {
      await onCreate(name, creating);
      setDraft("");
      setCreating(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside id="workspace-sidebar" className="channel-sidebar flex shrink-0 flex-col border-r">
      <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Channels
        </span>
        <button
          type="button"
          onClick={() => {
            setCreating(creating === "channel" ? null : "channel");
            setDraft("");
          }}
          className="ml-auto rounded-md border border-white/10 px-1.5 text-sm leading-5 text-slate-400 hover:bg-white/5 hover:text-slate-100"
          title="New channel"
        >
          +
        </button>
      </div>

      <nav
        className="sidebar-conversations flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2"
        aria-label="Conversations"
      >
        <ul className="space-y-0.5">
          {rooms.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              active={channel.id === activeChannelId}
              onSelect={() => onSelect(channel.id)}
              onRename={(name) => onRename(channel.id, name)}
              onArchive={() => onArchive(channel.id)}
            />
          ))}
          {rooms.length === 0 ? (
            <li className="px-2 py-1 text-xs text-slate-600">No channels yet.</li>
          ) : null}
        </ul>

        <div className="mt-5 flex items-center gap-2 px-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Direct
          </span>
          <button
            type="button"
            onClick={() => {
              if (busy) return;
              setBusy(true);
              const numbers = dms.map((channel) =>
                Number(channel.name.match(/^New conversation (\d+)$/)?.[1] ?? 0),
              );
              void onCreate(`New conversation ${Math.max(0, ...numbers) + 1}`, "dm").finally(() =>
                setBusy(false),
              );
            }}
            className="ml-auto rounded-md border border-white/10 px-1.5 text-sm leading-5 text-slate-400 hover:bg-white/5 hover:text-slate-100"
            disabled={busy}
            title="New direct conversation"
          >
            +
          </button>
        </div>

        <ul className="mt-1 space-y-0.5">
          {dms.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              active={channel.id === activeChannelId}
              onSelect={() => onSelect(channel.id)}
              onRename={(name) => onRename(channel.id, name)}
              onArchive={() => onArchive(channel.id)}
            />
          ))}
          {dms.length === 0 ? (
            <li className="px-2 py-1 text-xs text-slate-600">No direct conversations.</li>
          ) : null}
        </ul>
        {settled.length ? (
          <section className="settled-conversations" aria-label="Settled conversations">
            <div className="settled-heading">
              <Icon name="archive" />
              <h2>Settled</h2>
              <span>{settled.length}</span>
            </div>
            <ul className="space-y-0.5">
              {settled.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  active={channel.id === activeChannelId}
                  onSelect={() => onSelect(channel.id)}
                  onRename={(name) => onRename(channel.id, name)}
                  onArchive={() => onArchive(channel.id)}
                  onRestore={onRestore ? () => onRestore(channel.id) : undefined}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </nav>

      {creating ? (
        <form
          className="border-t border-white/10 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="text-[10px] uppercase tracking-wide text-slate-500">
            {creating === "dm" ? "Direct name" : "Channel name"}
          </label>
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={creating === "dm" ? "Ada" : "research"}
            className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent-400/50"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="submit"
              disabled={busy || draft.trim().length === 0}
              className="rounded-md bg-accent-400 px-2 py-1 text-[11px] font-semibold text-slate-950 disabled:opacity-40"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setCreating(null)}
              className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-300"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="border-t border-white/5 px-4 py-3 text-[10px] leading-4 text-slate-600">
          Vektor v{APP_VERSION}
        </p>
      )}
    </aside>
  );
}
