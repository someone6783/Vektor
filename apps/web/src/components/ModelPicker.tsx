import { ChoicePicker } from "./ChoicePicker";
import { Icon } from "./Icon";
import { useEffect, useRef, useState } from "react";
import { type ModelInfo, type ReasoningEffort, type RunnerId } from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { useAnchoredMenu } from "../lib/useAnchoredMenu";

const FAVORITES_KEY = "vektor.favoriteModels";
function readFavorites(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function ModelPicker({
  client,
  model,
  models,
  runner = "native",
  label = "Conversation model",
  onChange,
  reasoning = "auto",
  onReasoningChange,
}: {
  client: ApiClient;
  model: string;
  models: ModelInfo[];
  runner?: RunnerId;
  label?: string;
  onChange?: (model: string) => void;
  reasoning?: ReasoningEffort;
  onReasoningChange?: (value: ReasoningEffort) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useAnchoredMenu(menu);
  const [favorites, setFavorites] = useState(readFavorites);
  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    } catch {
      /* Keep session favourites if storage is blocked. */
    }
  }, [favorites]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === FAVORITES_KEY) setFavorites(readFavorites());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const [catalog, setCatalog] = useState(runner === "native" ? models : []);
  const selection = useRef({ model, onChange });
  selection.current = { model, onChange };
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setCatalog(runner === "native" ? models : []);
    const request =
      runner === "native"
        ? client.listModels().then((models) => ({ models, defaultModel: "" }))
        : client.listRunnerModels(runner);
    request
      .then((next) => {
        if (!active) return;
        setCatalog(next.models);
        if (runner !== "native" && !next.models.some((item) => item.id === selection.current.model))
          selection.current.onChange?.(next.defaultModel);
      })
      .catch((cause) => {
        if (active)
          setError(
            runner === "native"
              ? "Couldn’t load models."
              : cause instanceof Error
                ? cause.message
                : "Couldn’t load agent models.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, runner, refresh]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const items =
    runner !== "native" || catalog.some((item) => item.id === model)
      ? catalog
      : [{ id: model, name: model }, ...catalog];
  const filtered = items
    .filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(query.toLowerCase()))
    .sort(
      (left, right) => Number(favorites.includes(right.id)) - Number(favorites.includes(left.id)),
    );
  const selected =
    catalog.find((item) => item.id === model) ?? models.find((item) => item.id === model);
  const efforts = selected?.reasoningEfforts ?? [];
  const available: ReasoningEffort[] =
    selected?.supportsReasoning === false
      ? ["auto"]
      : [
          "auto",
          "on",
          ...(selected?.reasoningMandatory ? [] : ["none" as const]),
          ...efforts.filter((value) => !["auto", "on", "none"].includes(value)),
        ];
  const effective = available.includes(reasoning) ? reasoning : "auto";
  useEffect(() => {
    if (!loading && reasoning !== effective) onReasoningChange?.("auto");
  }, [loading, reasoning, effective, onReasoningChange]);
  const reasoningLabels: Record<ReasoningEffort, string> = {
    auto: "Auto",
    on: "On",
    none: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Maximum",
  };
  return (
    <div className="composer-model-controls">
      <details
        ref={menu}
        className="model-picker"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}
        onToggle={(event) => {
          if (event.currentTarget.open) event.currentTarget.querySelector("input")?.focus();
        }}
      >
        <summary className="header-control" aria-label={label} title={model}>
          <span>
            {runner !== "native" && loading
              ? "Loading agent models…"
              : runner === "native"
                ? model
                : (selected?.name ?? model)}
          </span>
          <span aria-hidden="true">▾</span>
        </summary>
        <div className="model-menu">
          <input
            aria-label="Search models"
            placeholder="Search models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {loading ? <p role="status">Loading models…</p> : null}
          {error ? (
            <p role="alert">
              {error}{" "}
              <button type="button" onClick={() => setRefresh((value) => value + 1)}>
                Retry
              </button>
            </p>
          ) : null}
          <div role="listbox" aria-label="Available models">
            {filtered.map((item) => (
              <div key={item.id} className="model-option-row" data-selected={item.id === model}>
                <button
                  type="button"
                  role="option"
                  aria-selected={item.id === model}
                  key={item.id}
                  onClick={() => {
                    onChange?.(item.id);
                    onReasoningChange?.("auto");
                    if (menu.current) {
                      menu.current.open = false;
                      menu.current.querySelector("summary")?.focus();
                    }
                  }}
                >
                  <span>{item.name}</span>
                  <small>{item.id}</small>
                </button>
                <button
                  type="button"
                  className="model-star"
                  aria-label={`${favorites.includes(item.id) ? "Unstar" : "Star"} ${item.name}`}
                  aria-pressed={favorites.includes(item.id)}
                  title={
                    favorites.includes(item.id) ? "Remove from favourites" : "Add to favourites"
                  }
                  onClick={() =>
                    setFavorites((value) =>
                      value.includes(item.id)
                        ? value.filter((id) => id !== item.id)
                        : [...value, item.id],
                    )
                  }
                >
                  <Icon name="star" />
                </button>
              </div>
            ))}
            {!loading && !error && !filtered.length ? <p>No matching models.</p> : null}
          </div>
        </div>
      </details>
      {runner === "native" ? (
        <ChoicePicker
          label="Reasoning effort"
          value={effective}
          className="reasoning-picker"
          title={
            selected?.supportsReasoning === false
              ? "This model does not support reasoning controls"
              : "Reasoning effort"
          }
          disabled={selected?.supportsReasoning === false || !onReasoningChange}
          prefix={<span className="choice-prefix">Reasoning</span>}
          options={available.map((value) => ({ value, label: reasoningLabels[value] }))}
          onChange={(value) => onReasoningChange?.(value as ReasoningEffort)}
        />
      ) : null}
    </div>
  );
}
