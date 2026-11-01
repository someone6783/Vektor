import { useState, type ReactNode } from "react";
import type { LiveToolCall } from "../lib/live";

const labels: Record<string, string> = {
  url: "Page",
  ref: "Element",
  ms: "Duration",
  tabId: "Tab",
  attachmentId: "File",
  filename: "Filename",
  text: "Text",
  privateInput: "Private input",
  cwd: "Working directory",
  timeoutMs: "Time limit",
  exitCode: "Exit code",
  isError: "Error",
  output: "Output",
};
const label = (key: string) =>
  labels[key] ??
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (value) => value.toUpperCase());
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function LinkValue({ value }: { value: string }) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol))
      return (
        <a href={url.href} target="_blank" rel="noreferrer">
          {value}
        </a>
      );
  } catch {
    /* Display non-URLs as ordinary text. */
  }
  return <span>{value}</span>;
}
function Fields({ value, depth = 0 }: { value: Record<string, unknown>; depth?: number }) {
  return (
    <dl className="tool-fields">
      {Object.entries(value)
        .filter(([, item]) => item !== undefined && item !== null)
        .map(([key, item]) => (
          <div key={key}>
            <dt>{label(key)}</dt>
            <dd>
              {["ms", "timeoutMs", "durationMs"].includes(key) && typeof item === "number" ? (
                `${item / 1000}s`
              ) : (
                <Value value={item} depth={depth + 1} />
              )}
            </dd>
          </div>
        ))}
    </dl>
  );
}
function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (value === null || value === undefined) return <span className="tool-empty">None</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "string") return <LinkValue value={value} />;
  if (typeof value === "number") return <span>{value.toLocaleString()}</span>;
  if (depth >= 5 && !expanded)
    return (
      <button type="button" onClick={() => setExpanded(true)}>
        Show details
      </button>
    );
  if (Array.isArray(value))
    return value.length ? (
      <ul className="tool-values">
        {value.map((item, index) => (
          <li key={index}>
            <Value value={item} depth={expanded ? 0 : depth + 1} />
          </li>
        ))}
      </ul>
    ) : (
      <span className="tool-empty">None</span>
    );
  if (record(value)) return <Fields value={value} depth={expanded ? 0 : depth} />;
  return null;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tool-detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function BrowserResult({ result }: { result: Record<string, unknown> }) {
  const snapshot = typeof result.snapshot === "string" ? result.snapshot : "";
  const content = snapshot
    .split("\nElements (references expire")[0]!
    .replace(/^UNTRUSTED PAGE DATA[^\n]*\n?/, "")
    .trim();
  const tabs = Array.isArray(result.tabs) ? result.tabs.filter(record) : [];
  const facts = Object.fromEntries(
    Object.entries({
      Access:
        result.mode === "observe"
          ? "Observation"
          : result.mode === "interactive"
            ? "Interactive"
            : undefined,
      Session:
        result.session === "default"
          ? "Saved profile"
          : result.session === "separate"
            ? "Temporary"
            : undefined,
      Browser:
        result.display === "window"
          ? "Visible window"
          : result.display === "headless"
            ? "Headless"
            : undefined,
    }).filter(([, value]) => value !== undefined),
  );
  const known = new Set([
    "untrusted",
    "mode",
    "session",
    "display",
    "phase",
    "active",
    "paused",
    "sensitive",
    "url",
    "tabs",
    "actions",
    "snapshot",
    "artifactId",
    "error",
    "note",
  ]);
  const other = Object.fromEntries(Object.entries(result).filter(([key]) => !known.has(key)));
  return (
    <div className="tool-browser-result">
      {typeof result.url === "string" && result.url !== "about:blank" ? (
        <div className="tool-page-url">
          <LinkValue value={result.url} />
        </div>
      ) : null}
      {Object.keys(facts).length ? (
        <div className="tool-result-tags">
          {Object.entries(facts).map(([key, value]) => (
            <span key={key} title={key}>
              {value}
            </span>
          ))}
          {result.paused === true ? <span>Paused</span> : null}
        </div>
      ) : null}
      {typeof result.error === "string" && result.error ? (
        <p className="tool-result-error">{result.error}</p>
      ) : null}
      {typeof result.note === "string" ? <p className="tool-prose">{result.note}</p> : null}
      {result.artifactId ? <p className="tool-prose">Screenshot captured</p> : null}
      {tabs.length ? (
        <details className="tool-page-section">
          <summary>
            {tabs.length} open {tabs.length === 1 ? "tab" : "tabs"}
          </summary>
          <ul className="tool-tab-list">
            {tabs.map((tab, index) => (
              <li key={index}>
                <span>{index + 1}</span>
                {typeof tab.url === "string" ? <LinkValue value={tab.url} /> : "Untitled tab"}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {content ? (
        <details className="tool-page-section">
          <summary>Page content</summary>
          <div className="tool-page-content">
            {content.split("\n").map((line, index) => {
              const text = line.replace(/^\s*-\s?/, "").trim();
              if (!text || /^(main|banner|navigation|contentinfo|list|generic):$/.test(text))
                return null;
              const heading = /^heading "(.*)" \[level=\d+\]:?$/.exec(text);
              const readable =
                heading?.[1] ??
                text
                  .replace(/^(paragraph|text):\s*/, "")
                  .replace(
                    /^(link|button) "(.*)":?$/,
                    (_, role: string, name: string) => `${label(role)}: ${name}`,
                  )
                  .replace(/^\/url:\s*/, "Link: ");
              return (
                <p key={index} className={heading ? "tool-page-title" : undefined}>
                  {readable}
                </p>
              );
            })}
          </div>
        </details>
      ) : null}
      {Object.keys(other).length ? <Fields value={other} /> : null}
    </div>
  );
}
export function ToolDetails({ tool }: { tool: LiveToolCall }) {
  const input = record(tool.input) ? tool.input : {};
  const browser = tool.name.startsWith("browser");
  const terminal = tool.name === "terminal";
  const request = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !(browser && key === "action") && !(terminal && ["command", "args"].includes(key)),
    ),
  );
  const result = parse(tool.output);
  const browserState =
    browser &&
    record(result) &&
    ["snapshot", "tabs", "mode", "phase", "url"].some((key) => key in result);
  return (
    <>
      {terminal && typeof input.command === "string" ? (
        <Section title="Command">
          <pre className="tool-command">
            {[input.command, ...(Array.isArray(input.args) ? input.args.map(String) : [])].join(
              " ",
            )}
          </pre>
        </Section>
      ) : null}
      {Object.keys(request).length ? (
        <Section title={browser ? "Action details" : "Parameters"}>
          <Fields value={request} />
        </Section>
      ) : null}
      {tool.input !== undefined && !record(tool.input) ? (
        <Section title="Parameters">
          <Value value={tool.input} />
        </Section>
      ) : null}
      {tool.output ? (
        <Section title={browserState ? "Browser" : "Result"}>
          {browserState ? (
            <BrowserResult result={result as Record<string, unknown>} />
          ) : terminal && record(result) && "output" in result ? (
            <>
              {typeof result.output === "string" && result.output ? (
                <pre className="tool-output">{result.output}</pre>
              ) : null}
              <Fields
                value={Object.fromEntries(
                  Object.entries(result).filter(([key]) => !["output", "isError"].includes(key)),
                )}
              />
            </>
          ) : (
            <div
              className={
                tool.status === "failed" || tool.status === "denied"
                  ? "tool-result-error"
                  : "tool-prose"
              }
            >
              <Value value={result} />
            </div>
          )}
        </Section>
      ) : ["running", "waiting", "requested"].includes(tool.status) ? (
        <p className="tool-empty">
          {tool.status === "waiting" ? "Waiting for approval…" : "Waiting for result…"}
        </p>
      ) : null}
    </>
  );
}
