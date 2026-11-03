import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApiClient } from "../lib/api";
import { GitView } from "./GitView";
import { FileViewer } from "./FileViewer";
import { Icon } from "./Icon";

type WorkspaceTab =
  | { id: string; kind: "context"; label: string }
  | { id: string; kind: "git"; label: string }
  | { id: string; kind: "file"; label: string; path: string; file: string };

interface WorkspaceTabsProps {
  client: ApiClient;
  activeTab: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  children: ReactNode;
}

export function WorkspaceTabs({
  client,
  activeTab,
  onSelect,
  onClose,
  children,
}: WorkspaceTabsProps) {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { id: "context", kind: "context", label: "Context" },
    { id: "git", kind: "git", label: "Git" },
  ]);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab]);
  const openFile = (path: string, file: string) => {
    const id = `file:${encodeURIComponent(JSON.stringify([path, file]))}`;
    setTabs((current) =>
      current.some((tab) => tab.id === id)
        ? current
        : [...current, { id, kind: "file", label: file.split("/").pop() ?? file, path, file }],
    );
    onSelect(id);
  };
  const closeFile = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    const selected = activeTab === id ? next[Math.max(0, index - 1)]!.id : activeTab;
    if (activeTab === id) onSelect(selected);
    requestAnimationFrame(() => {
      strip.current
        ?.querySelector<HTMLButtonElement>(
          `[data-tab-index="${next.findIndex((tab) => tab.id === selected)}"]`,
        )
        ?.focus();
    });
  };
  return (
    <>
      <div className="workspace-tabs-heading">
        <div ref={strip} role="tablist" aria-label="Workspace tabs" className="workspace-tabs">
          {tabs.map((tab, index) => (
            <div key={tab.id} className="workspace-tab" data-active={activeTab === tab.id}>
              <button
                type="button"
                role="tab"
                id={`workspace-tab-${tab.id}`}
                aria-controls={`workspace-panel-${tab.id}`}
                aria-selected={activeTab === tab.id}
                tabIndex={activeTab === tab.id ? 0 : -1}
                data-tab-index={index}
                title={tab.kind === "file" ? `${tab.path}/${tab.file}` : tab.label}
                onClick={() => onSelect(tab.id)}
                onKeyDown={(event) => {
                  let next: number;
                  if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
                  else if (event.key === "ArrowLeft")
                    next = (index + tabs.length - 1) % tabs.length;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = tabs.length - 1;
                  else if (event.key === "Delete" && tab.kind === "file") {
                    event.preventDefault();
                    closeFile(tab.id);
                    return;
                  } else return;
                  event.preventDefault();
                  onSelect(tabs[next]!.id);
                  strip.current
                    ?.querySelector<HTMLButtonElement>(`[data-tab-index="${next}"]`)
                    ?.focus();
                }}
              >
                {tab.label}
              </button>
              {tab.kind === "file" ? (
                <button
                  type="button"
                  aria-label={`Close ${tab.file}`}
                  onClick={() => closeFile(tab.id)}
                >
                  <Icon name="close" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <button type="button" aria-label="Close context" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`workspace-panel-${tab.id}`}
          aria-labelledby={`workspace-tab-${tab.id}`}
          hidden={activeTab !== tab.id}
        >
          {tab.kind === "context" ? (
            children
          ) : tab.kind === "git" ? (
            <GitView client={client} onOpenFile={openFile} />
          ) : (
            <FileViewer client={client} path={tab.path} file={tab.file} />
          )}
        </div>
      ))}
    </>
  );
}
