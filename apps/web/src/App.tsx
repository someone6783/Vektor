import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Channel,
  Message,
  Profile,
  Run,
  SettingsView as SettingsViewData,
} from "@vektor/shared";
import { ChatView } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { RuntimeControls } from "./components/RuntimeControls";
import { AuditView } from "./components/AuditView";
import { SchedulesView } from "./components/SchedulesView";
import { ApiClient, ApiError } from "./lib/api";
import { applyRunEvent, startLiveRun, type LiveRun } from "./lib/live";
import { apiFetch, backendUrl, tokenStorageKey } from "./lib/transport";
import { isTauri, invoke } from "@tauri-apps/api/core";

const CHANNEL_STORAGE_KEY = "vektor.activeChannel";
const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);

function readStoredToken(): string {
  try {
    return (
      localStorage.getItem(tokenStorageKey()) ??
      (isTauri() ? "" : (import.meta.env.VITE_ACCESS_TOKEN ?? ""))
    );
  } catch {
    return isTauri() ? "" : (import.meta.env.VITE_ACCESS_TOKEN ?? "");
  }
}

function readStoredChannel(): string | null {
  try {
    return localStorage.getItem(CHANNEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredChannel(channelId: string | null): void {
  try {
    if (channelId) {
      localStorage.setItem(CHANNEL_STORAGE_KEY, channelId);
    } else {
      localStorage.removeItem(CHANNEL_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private windows.
  }
}

function TokenGate({
  draft,
  error,
  onChange,
  onSubmit,
  onConnection,
}: {
  draft: string;
  error: string | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onConnection?: () => void;
}) {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-950 px-6 text-slate-100">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-400 text-lg font-bold text-slate-950">
            V
          </div>
          <div>
            <div className="text-sm font-semibold tracking-wide">Vektor</div>
            <div className="text-xs text-slate-500">Connect to your local workspace</div>
          </div>
        </div>

        <form
          className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-5"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Access token
          </label>
          <input
            autoFocus
            type="password"
            value={draft}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Paste the token from /data/access-token"
            autoComplete="off"
            className="mt-2 w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-emerald-400/50"
          />
          {error ? (
            <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-200">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={draft.trim().length === 0}
            className="mt-4 w-full rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40"
          >
            Unlock workspace
          </button>
          <p className="mt-3 text-[10px] leading-4 text-slate-600">
            The token is stored in this browser only. Docker keeps it at{" "}
            <code className="font-mono text-slate-500">/data/access-token</code>.
          </p>
          {onConnection ? (
            <button type="button" onClick={onConnection} className="mt-4 text-xs text-emerald-300">
              Backend connection
            </button>
          ) : null}
        </form>
      </div>
    </div>
  );
}

export default function App({ onConnection }: { onConnection?: () => void } = {}) {
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const [emergencyStopped, setEmergencyStopped] = useState(false);
  const [activeRunCount, setActiveRunCount] = useState(0);
  const [token, setToken] = useState(readStoredToken);
  const [tokenDraft, setTokenDraft] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  const [view, setView] = useState<"chat" | "settings" | "audit" | "schedules">("chat");
  const [settings, setSettings] = useState<SettingsViewData | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [online, setOnline] = useState(true);

  const client = useMemo(() => (token ? new ApiClient(token) : null), [token]);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke("configure_connection", {
      baseUrl: backendUrl(),
      token,
      notifications: localStorage.getItem("vektor.desktop.notifications") === "true",
    }).catch((error: unknown) => setError(String(error)));
    return () => {
      void invoke("clear_connection");
    };
  }, [token]);

  const activeChannel = useMemo(
    () => channels.find((channel) => channel.id === activeChannelId) ?? null,
    [channels, activeChannelId],
  );

  const activeProfile = useMemo(() => {
    if (activeChannel?.profileId) {
      const match = profiles.find((profile) => profile.id === activeChannel.profileId);
      if (match) {
        return match;
      }
    }

    return profiles[0] ?? null;
  }, [activeChannel, profiles]);

  const bootedRef = useRef<string | null>(null);
  const activeChannelIdRef = useRef<string | null>(null);
  const clientRef = useRef<ApiClient | null>(client);
  const streamRef = useRef<{ controller: AbortController; runId: string } | null>(null);
  const sendingRef = useRef(false);

  clientRef.current = client;

  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

  const reportError = useCallback((nextError: unknown) => {
    if (nextError instanceof ApiError && nextError.status === 401) {
      try {
        localStorage.removeItem(tokenStorageKey());
      } catch {
        // Ignore storage failures.
      }
      bootedRef.current = null;
      setAuthError("Access token rejected. Paste the token from /data/access-token.");
      setToken("");
      setTokenDraft("");
      return;
    }

    setError(nextError instanceof Error ? nextError.message : "Something went wrong.");
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.controller.abort();
    streamRef.current = null;
  }, []);

  const finalizeRef = useRef<(runId: string, channelId: string) => void>(() => {});

  finalizeRef.current = (runId, channelId) => {
    const current = clientRef.current;
    if (!current || activeChannelIdRef.current !== channelId) {
      return;
    }

    void (async () => {
      try {
        const page = await current.listMessages(channelId);
        if (activeChannelIdRef.current !== channelId) {
          return;
        }

        setMessages((value) => {
          const known = new Set(page.messages.map((message) => message.id));
          const oldest = page.messages[0]?.createdAt;
          const older = value.filter(
            (message) => !known.has(message.id) && (!oldest || message.createdAt < oldest),
          );
          return [...older, ...page.messages];
        });
        setNextBefore((value) => value ?? page.nextBefore);
        setLastRun(page.lastRun);
        setLive((value) => (value && value.runId === runId ? null : value));
      } catch (nextError) {
        reportError(nextError);
      }
    })();
  };

  const subscribe = useCallback(
    (runId: string, channelId: string, after: number) => {
      const current = clientRef.current;
      if (!current) {
        return;
      }

      stopStream();
      const controller = new AbortController();
      streamRef.current = { controller, runId };
      setLive((value) =>
        value && value.runId === runId ? value : { ...startLiveRun(runId), lastSeq: after },
      );

      void (async () => {
        let cursor = after;
        let attempt = 0;

        while (!controller.signal.aborted) {
          let terminal = false;

          try {
            await current.streamRun(
              runId,
              cursor,
              (event) => {
                cursor = Math.max(cursor, event.seq);
                attempt = 0;
                if (TERMINAL_EVENTS.has(event.type)) {
                  terminal = true;
                }
                setLive((value) =>
                  applyRunEvent(
                    value && value.runId === runId ? value : startLiveRun(runId),
                    event,
                  ),
                );
              },
              controller.signal,
            );
          } catch (nextError) {
            if (controller.signal.aborted) {
              return;
            }
            attempt += 1;
            if (attempt > 5) {
              reportError(nextError);
              return;
            }
          }

          if (controller.signal.aborted) {
            return;
          }

          if (terminal) {
            if (streamRef.current?.controller === controller) {
              streamRef.current = null;
            }
            finalizeRef.current(runId, channelId);
            return;
          }

          attempt += 1;
          if (attempt > 5) {
            setLive((value) => (value && value.runId === runId ? null : value));
            setError("The live stream disconnected. Reload the channel to catch up.");
            return;
          }

          await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 400 * attempt)));
        }
      })();
    },
    [reportError, stopStream],
  );

  useEffect(() => {
    if (!client || !token) {
      return;
    }
    if (bootedRef.current === token) {
      return;
    }
    bootedRef.current = token;

    setBooting(true);
    setError(null);

    void (async () => {
      try {
        const [nextSettings, nextProfiles, loadedChannels] = await Promise.all([
          client.getSettings(),
          client.listProfiles(),
          client.listChannels(),
        ]);

        if (bootedRef.current !== token) {
          return;
        }

        setSettings(nextSettings);
        setProfiles(nextProfiles);

        let nextChannels = loadedChannels;
        if (nextChannels.length === 0 && nextProfiles.length > 0) {
          const general = await client.createChannel({
            name: "General",
            topic: "Your first Vektor channel",
          });
          nextChannels = [general];
        }

        if (bootedRef.current !== token) {
          return;
        }

        setChannels(nextChannels);
        const stored = readStoredChannel();
        const nextActive =
          nextChannels.find((channel) => channel.id === stored)?.id ?? nextChannels[0]?.id ?? null;
        setActiveChannelId(nextActive);
        writeStoredChannel(nextActive);
        setAuthError(null);
      } catch (nextError) {
        if (bootedRef.current === token) {
          reportError(nextError);
        }
      } finally {
        if (bootedRef.current === token) {
          setBooting(false);
        }
      }
    })();
  }, [client, token, reportError]);

  useEffect(() => {
    if (!token) {
      bootedRef.current = null;
    }
  }, [token]);

  useEffect(() => {
    let active = true;

    const ping = async () => {
      try {
        const response = await apiFetch("/healthz", { headers: { Accept: "application/json" } });
        if (active) {
          setOnline(response.ok);
        }
      } catch {
        if (active) {
          setOnline(false);
        }
      }
    };

    void ping();
    const timer = setInterval(() => void ping(), 15_000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!client || !activeChannelId) {
      setMessages([]);
      setNextBefore(null);
      setLive(null);
      setLoadingMessages(false);
      return;
    }

    let cancelled = false;
    stopStream();
    setLive(null);
    setMessages([]);
    setNextBefore(null);
    setLoadingMessages(true);
    setError(null);

    void (async () => {
      try {
        const page = await client.listMessages(activeChannelId);
        if (cancelled) {
          return;
        }

        setMessages(page.messages);
        setNextBefore(page.nextBefore);
        setLastRun(page.lastRun);

        if (page.activeRun && page.activeRun.status === "running") {
          subscribe(page.activeRun.id, activeChannelId, 0);
        }
      } catch (nextError) {
        if (!cancelled) {
          reportError(nextError);
        }
      } finally {
        if (!cancelled) {
          setLoadingMessages(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [client, activeChannelId, subscribe, stopStream, reportError]);

  const selectChannel = useCallback(
    (channelId: string) => {
      stopStream();
      setLive(null);
      setActiveChannelId(channelId);
      writeStoredChannel(channelId);
      setView("chat");
    },
    [stopStream],
  );

  useEffect(() => {
    if (!client || !activeChannelId || view !== "chat") return;
    let active = true;
    const timer = setInterval(() => {
      if (streamRef.current || sendingRef.current) return;
      void client
        .listMessages(activeChannelId)
        .then((page) => {
          if (
            !active ||
            activeChannelIdRef.current !== activeChannelId ||
            streamRef.current ||
            sendingRef.current
          )
            return;
          setMessages((value) => {
            const ids = new Set(page.messages.map((message) => message.id));
            const oldest = page.messages[0]?.createdAt;
            return [
              ...value.filter(
                (message) => !ids.has(message.id) && oldest && message.createdAt < oldest,
              ),
              ...page.messages,
            ];
          });
          setLastRun(page.lastRun);
          setNextBefore((value) => value ?? page.nextBefore);
          if (page.activeRun) {
            setLive(startLiveRun(page.activeRun.id));
            subscribe(page.activeRun.id, activeChannelId, 0);
          }
        })
        .catch((error) => {
          if (active) reportError(error);
        });
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, activeChannelId, view, subscribe, reportError]);

  const sendMessage = useCallback(
    async (content: string, attachmentIds: string[], allowTruncation: boolean) => {
      if (!client || !activeChannelId) {
        return;
      }

      setError(null);
      sendingRef.current = true;
      const optimisticId = `optimistic-${Date.now()}`;
      const optimistic: Message = {
        id: optimisticId,
        channelId: activeChannelId,
        role: "user",
        content,
        status: "complete",
        runId: null,
        createdAt: new Date().toISOString(),
        attachments: [],
      };

      setMessages((value) => [...value, optimistic]);

      try {
        const response = await client.sendMessage(
          activeChannelId,
          content,
          activeChannel?.profileId ?? activeProfile?.id,
          attachmentIds,
          allowTruncation,
        );

        setMessages((value) =>
          value.map((message) => (message.id === optimisticId ? response.message : message)),
        );
        setLive(startLiveRun(response.run.id));
        setLastRun(response.run);
        subscribe(response.run.id, activeChannelId, 0);
      } catch (nextError) {
        setMessages((value) => value.filter((message) => message.id !== optimisticId));
        reportError(nextError);
        throw nextError;
      } finally {
        sendingRef.current = false;
      }
    },
    [client, activeChannelId, activeChannel, activeProfile, subscribe, reportError],
  );

  const stopRun = useCallback(() => {
    if (!client || !live || live.status !== "running") {
      return;
    }

    void client.cancelRun(live.runId).catch(reportError);
  }, [client, live, reportError]);

  const retryRun = useCallback(
    (runId: string) => {
      if (!client || !activeChannelId) {
        return;
      }

      void (async () => {
        try {
          const estimate = await client.retryContext(runId);
          if (estimate.exceedsBudget)
            throw new Error(
              "This retry exceeds the context budget. Exclude files or lower the profile's max output tokens before retrying.",
            );
          if (
            estimate.requiresTruncation &&
            !window.confirm(
              `Retry with ${estimate.inputTokens} estimated input tokens? ${estimate.droppedMessages} oldest messages will be omitted. Saved history is preserved.`,
            )
          )
            return;
          const run = await client.retryRun(runId, estimate.requiresTruncation);
          setLastRun(run);
          setMessages((value) =>
            value.filter((message) => !(message.role === "assistant" && message.runId === runId)),
          );
          setLive(startLiveRun(run.id));
          subscribe(run.id, activeChannelId, 0);
        } catch (nextError) {
          reportError(nextError);
        }
      })();
    },
    [client, activeChannelId, subscribe, reportError],
  );

  const loadMore = useCallback(() => {
    if (!client || !activeChannelId || !nextBefore || loadingMore) {
      return;
    }

    const channelId = activeChannelId;
    setLoadingMore(true);

    void (async () => {
      try {
        const page = await client.listMessages(channelId, nextBefore);
        if (activeChannelIdRef.current !== channelId) {
          return;
        }

        setMessages((value) => {
          const known = new Set(value.map((message) => message.id));
          return [...page.messages.filter((message) => !known.has(message.id)), ...value];
        });
        setNextBefore(page.nextBefore);
      } catch (nextError) {
        reportError(nextError);
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [client, activeChannelId, nextBefore, loadingMore, reportError]);

  const createChannel = useCallback(
    async (name: string, kind: "channel" | "dm") => {
      if (!client) {
        return;
      }

      try {
        const channel = await client.createChannel({
          name,
          kind,
          ...(activeProfile ? { profileId: activeProfile.id } : {}),
        });
        setChannels((value) => [...value, channel]);
        setActiveChannelId(channel.id);
        writeStoredChannel(channel.id);
        setView("chat");
      } catch (nextError) {
        reportError(nextError);
      }
    },
    [client, activeProfile, reportError],
  );

  const renameChannel = useCallback(
    async (channelId: string, name: string) => {
      if (!client) {
        return;
      }

      try {
        const updated = await client.updateChannel(channelId, { name });
        setChannels((value) =>
          value.map((channel) => (channel.id === updated.id ? updated : channel)),
        );
      } catch (nextError) {
        reportError(nextError);
      }
    },
    [client, reportError],
  );

  const archiveChannel = useCallback(
    async (channelId: string) => {
      if (!client) {
        return;
      }

      try {
        await client.archiveChannel(channelId);
        const remaining = channels.filter((channel) => channel.id !== channelId);
        setChannels(remaining);

        if (activeChannelId === channelId) {
          const fallback = remaining[0]?.id ?? null;
          setActiveChannelId(fallback);
          writeStoredChannel(fallback);
          stopStream();
          setLive(null);
        }
      } catch (nextError) {
        reportError(nextError);
      }
    },
    [client, channels, activeChannelId, stopStream, reportError],
  );

  const switchProfile = useCallback(
    async (profileId: string) => {
      if (!client || !activeChannel) {
        return;
      }

      try {
        const updated = await client.updateChannel(activeChannel.id, { profileId });
        setChannels((value) =>
          value.map((channel) => (channel.id === updated.id ? updated : channel)),
        );
      } catch (nextError) {
        reportError(nextError);
      }
    },
    [client, activeChannel, reportError],
  );

  const refreshProfiles = useCallback(async () => {
    if (!client) {
      return;
    }

    try {
      const [nextProfiles, nextChannels, nextSettings] = await Promise.all([
        client.listProfiles(),
        client.listChannels(),
        client.getSettings(),
      ]);

      setProfiles(nextProfiles);
      setChannels(nextChannels);
      setSettings(nextSettings);

      if (activeChannelId && !nextChannels.some((channel) => channel.id === activeChannelId)) {
        const fallback = nextChannels[0]?.id ?? null;
        setActiveChannelId(fallback);
        writeStoredChannel(fallback);
      }
    } catch (nextError) {
      reportError(nextError);
    }
  }, [client, activeChannelId, reportError]);

  if (!token || !client) {
    return (
      <TokenGate
        onConnection={onConnection}
        draft={tokenDraft}
        error={authError}
        onChange={setTokenDraft}
        onSubmit={() => {
          const next = tokenDraft.trim();
          if (!next) {
            return;
          }
          try {
            localStorage.setItem(tokenStorageKey(), next);
          } catch {
            // Storage can be unavailable; the session still works.
          }
          setAuthError(null);
          setToken(next);
        }}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <header className="flex shrink-0 items-center gap-4 border-b border-white/10 bg-slate-950/80 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-400 text-sm font-bold text-slate-950">
            V
          </div>
          <span className="text-sm font-semibold tracking-wide">Vektor</span>
        </div>

        <nav className="flex items-center gap-1" aria-label="Sections">
          <button
            type="button"
            onClick={() => setView("chat")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              view === "chat"
                ? "bg-white/10 text-slate-100"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            Chat
          </button>
          <button
            type="button"
            onClick={() => setView("settings")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              view === "settings"
                ? "bg-white/10 text-slate-100"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            Settings
          </button>
        </nav>

        <button
          type="button"
          onClick={() => setView("schedules")}
          className={`rounded-lg px-3 py-1.5 text-xs ${view === "schedules" ? "bg-white/10 text-slate-100" : "text-slate-400"}`}
        >
          Schedules
        </button>

        <button
          type="button"
          onClick={() => setView("audit")}
          className={`rounded-lg px-3 py-1.5 text-xs ${view === "audit" ? "bg-white/10 text-slate-100" : "text-slate-400"}`}
        >
          Audit
        </button>

        <div className="ml-auto flex items-center gap-3">
          {onConnection ? (
            <button type="button" onClick={onConnection} className="text-xs text-slate-400">
              Backend
            </button>
          ) : null}
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] ${
              online
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                : "border-rose-400/30 bg-rose-400/10 text-rose-300"
            }`}
            title={online ? "API reachable" : "API unreachable"}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-400" : "bg-rose-400"}`}
            />
            {online ? "Local" : "Offline"}
          </span>

          {view === "chat" && profiles.length > 0 ? (
            <label className="flex items-center gap-2 rounded-lg border border-white/10 px-2 py-1">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: `var(--profile-${activeProfile?.color ?? "emerald"})` }}
              />
              <select
                value={activeProfile?.id ?? ""}
                onChange={(event) => void switchProfile(event.target.value)}
                className="max-w-40 truncate bg-transparent text-xs text-slate-200 outline-none"
                aria-label="Active profile"
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id} className="bg-slate-900">
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <RuntimeControls
            client={client}
            onStoppedChange={setEmergencyStopped}
            onActiveRunsChange={setActiveRunCount}
            onError={reportError}
          />

          <button
            type="button"
            onClick={() => {
              try {
                localStorage.removeItem(tokenStorageKey());
              } catch {
                // Ignore storage failures.
              }
              stopStream();
              bootedRef.current = null;
              setToken("");
              setTokenDraft("");
            }}
            className="rounded-md px-2 py-1 text-[10px] text-slate-500 hover:text-slate-200"
          >
            Lock
          </button>
        </div>
      </header>

      {booting ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Loading workspace…
          </div>
        </div>
      ) : view === "schedules" ? (
        <SchedulesView
          client={client}
          profiles={profiles}
          channels={channels}
          onOpenChannel={selectChannel}
        />
      ) : view === "audit" ? (
        <AuditView client={client} />
      ) : view === "settings" && settings ? (
        <SettingsView
          client={client}
          settings={settings}
          profiles={profiles}
          onSettingsChange={setSettings}
          onProfilesChange={refreshProfiles}
          onError={(message) => setError(message)}
        />
      ) : view === "settings" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          Settings are unavailable. Check the API connection.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Sidebar
            channels={channels}
            activeChannelId={activeChannelId}
            onSelect={selectChannel}
            onCreate={createChannel}
            onRename={renameChannel}
            onArchive={archiveChannel}
          />
          <ChatView
            activeRunCount={activeRunCount}
            emergencyStopped={emergencyStopped}
            client={client}
            lastRun={lastRun?.channelId === activeChannel?.id ? lastRun : null}
            channel={activeChannel}
            profile={activeProfile}
            messages={messages}
            live={live}
            loading={loadingMessages}
            loadingMore={loadingMore}
            hasMore={nextBefore !== null}
            error={error}
            onSend={sendMessage}
            onStop={stopRun}
            onRetry={retryRun}
            onLoadMore={loadMore}
          />
        </div>
      )}
    </div>
  );
}
