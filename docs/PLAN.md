# Vektor Product Plan

Status: v0.6 · 2026-10-31
Approval: Scope and Phase 0 accepted on 2026-10-31. Implementation may begin with Phase 1. OCR remains deferred, and v1 uses a single local access token.

## Product summary

Vektor is a single-user, local-first AI workspace. It combines:

- **Profiles** — reusable agent configurations: system prompt, default model, generation settings, tool access, terminal mode.
- **Slack-like conversations** — channels and direct conversations with persistent, scannable history.
- **Streamed chat** — token-by-token responses rendered as Markdown, with stop and regenerate.
- **Files and context** — pasted or uploaded documents and images, with explicit control over what enters the context window.
- **A permissioned terminal** — three access modes, approvals, an audit trail, and an emergency stop.
- **Scheduled runs** — recurring jobs that execute a profile and post results back into a channel.
- **Two shells** — Docker for the server, an optional Tauri app for the desktop.

Non-goals for v1 are listed under [Explicitly deferred](#explicitly-deferred).

After the first release, the roadmap adds browser use (Phase 9), computer use (Phase 10), and Codex harness integration (Phase 11). These are planned capabilities with their own exit criteria, not requirements for the first usable release.

## Approval gate

Scope and Phase 0 were approved on 2026-10-31. Phase 1 may start; each later phase starts only after the previous phase's exit criteria are demonstrated.

Working agreement:

1. Build one phase at a time against its exit criteria.
2. Demo the phase and get sign-off before starting the next.
3. Plan changes are edits to this file, reviewed before they affect code.

## Phase 0 — Decisions (accepted)

All decisions below were accepted on 2026-10-31 and recorded in the decision log at the end of this file.

### D1. Stack — accepted

Accepted: TypeScript monorepo with pnpm workspaces.

- `apps/web` — React + Vite + Tailwind.
- `apps/api` — Node.js LTS + Fastify.
- `packages/shared` — Zod contracts and shared types.
- `packages/db` — Drizzle schema, migrations, queries.
- SQLite in WAL mode as the single datastore.

Why: one language across UI, API, and contracts; SQLite fits a single-user local product and makes backup a file copy.

### D2. Deployment model — accepted

Accepted: Docker Compose is the primary install. One API container serves the built web app on `127.0.0.1:8787` by default, with a single volume mounted at `/data`. The container runs as an unprivileged user. Tauri (Phase 6) is a thin desktop shell over the same web UI, not a second backend.

### D3. Identity and access — accepted

Accepted: single user, no accounts. The API requires a locally generated access token stored in the data directory; the browser session gets it through a one-time setup flow. Bind to loopback unless the user explicitly changes it. Multi-user is deferred.

### D4. Agent runtime — accepted (hybrid)

V1 uses a Vektor-owned loop. The API calls OpenRouter chat completions with streaming and tool calling, executes tools itself, and persists every event. Permissions, approvals, audit, cancellation, and scheduling all sit inside a loop we control.

After v1, a runner interface adds the Codex harness as an optional execution backend for coding and longer-running agent tasks. All runners share Vektor's run-event contract, approval model, and audit trail; see [Phase 11 — Codex harness and hybrid runners](#phase-11--codex-harness-and-hybrid-runners). Browser and computer tools are separate permissioned capabilities in Phases 9–10, not implicit grants from choosing a runner.

### D5. Streaming and run events — accepted

Accepted: server-sent events (SSE) for one-way streams; REST for commands. Every run writes an ordered event log (`run.started`, `message.delta`, `tool.requested`, `tool.output`, `approval.requested`, `usage`, `run.completed` / `failed` / `cancelled`). The client subscribes with a sequence cursor, so a reload or reconnect replays missed events instead of losing output.

### D6. Conversation shape — accepted

V1 ships channels (named, with topic and optional archive) plus direct conversations, both with a flat message timeline. Threads, reactions, mentions, and unread state are deferred. A conversation belongs to one profile; switching the profile affects new runs and is shown in the timeline.

### D7. Profile model — accepted

Accepted: a profile stores name, avatar/color, system prompt, default model, generation parameters (temperature, max output tokens), terminal mode, enabled tools, and context defaults. Provider credentials are global settings, not per profile. A conversation can override the model per run without changing the profile.

### D8. Secrets — accepted

Accepted: the OpenRouter key is write-only from the client. The API encrypts it with AES-256-GCM using a key file generated on first boot (`/data/secrets.key`, mode `0600`). A `VEKTOR_OPENROUTER_KEY` environment variable overrides stored settings and is never persisted. Keys are redacted from logs and tool output.

### D9. Scheduler — accepted

Accepted: an in-process scheduler inside the API, backed by the same SQLite database. Jobs store cron expression, IANA time zone, profile, target channel, prompt, enabled flag, and next run time. A short database lease prevents duplicate firing if two instances ever run. Missed runs are skipped by default, with a per-job catch-up option. Overlapping runs for the same job are skipped.

### D10. Supported attachments — accepted

Accepted for v1:

- Text-like: `.txt`, `.md`, `.csv`, `.json`, and source code — read directly.
- Documents: PDF and DOCX — extract plain text; scanned PDFs without a text layer are rejected with a clear message (OCR deferred).
- Images: PNG, JPEG, WebP, GIF — stored and passed to vision-capable models.
- Per-file size cap (default 25 MB) and per-conversation storage cap, both configurable.

### D11. Terminal modes — accepted

Accepted semantics, enforced by the API rather than by prompt instructions:

- **No-terminal** — no command execution tool is exposed to the model.
- **Basic** — commands run as the unprivileged container user with checked paths inside `/data/workspace`, restricted commands/options, no implicit shell, an environment stripped of secrets, per-command timeout and output cap, and no Docker socket. This is a guardrail, not a hardened sandbox; the container boundary is the real isolation. The UI says so.
- **Full access** — unrestricted paths inside the container, with a warning, approval before every command (including destructive or privileged commands), and full audit logging.

All modes get run timelines, cancellation, and audit entries. The global emergency stop kills active runs, their process groups, and the scheduler's pending work. On desktop, full access also warns that commands run on the host, not in a container.

### D12. Desktop strategy — accepted

Accepted: Tauri wraps the built web UI and connects to a backend URL chosen on first launch (default `http://127.0.0.1:8787`). No bundled sidecar in v1. Notifications and tray actions talk to the API.

### D13. Version 1 provider scope — accepted

Accepted: OpenRouter only for v1, using its model list and usage reporting. The provider layer is an internal interface so another provider can be added later without changing the UI. Phase 11's Codex harness is a separate post-v1 runner integration with its own authentication and capability checks; it is not merely a Codex-named model selected through OpenRouter.

### D14. Releases and update checks — accepted

Accepted: GitHub Actions builds and publishes tagged releases to GitHub Releases and GitHub Container Registry. The API checks GitHub Releases for a newer version, caches the result, and notifies in the UI. The check is optional and sends no local data; v1 does not self-update.

## Architecture

```text
┌──────────────┐   REST + SSE   ┌──────────────────────────────┐
│  React web   │ ◄────────────► │  Fastify API                 │
│  (or Tauri)  │                │  ├─ settings / secrets       │
└──────────────┘                │  ├─ profiles / channels      │
                                │  ├─ agent runner ── OpenRouter│
                                │  │   (Codex harness post-v1)  │
                                │  ├─ tool executor ── terminal │
                                │  ├─ scheduler                │
                                │  └─ SSE event hub            │
                                └──────────┬───────────────────┘
                                           │
                                ┌──────────▼───────────────────┐
                                │  /data                       │
                                │  ├─ vektor.db (SQLite, WAL)  │
                                │  ├─ files/<attachment-id>    │
                                │  ├─ workspace/               │
                                │  ├─ logs/                    │
                                │  └─ secrets.key (0600)       │
                                └──────────────────────────────┘
```

### Run lifecycle

1. Client posts a message; the API stores it and creates a run.
2. The runner assembles context: profile prompt, recent conversation history, selected attachments, tool definitions.
3. The active runner streams from OpenRouter and appends every delta and tool event to the run log. V1 has one runner; the Codex harness adapter arrives in Phase 11 after v1.
4. Tool calls pause the run if they need approval; the UI resolves the approval and the run resumes.
5. On completion the assistant message, usage, and final status are persisted; the event stream closes.
6. Cancel sets the run to `cancelled`, aborts the provider request, and kills any child process group.

### Data model (draft)

| Table            | Purpose                     | Key fields                                                                               |
| ---------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `settings`       | Global config               | `key`, `value_json`, `updated_at`                                                        |
| `profiles`       | Agent configurations        | `name`, `system_prompt`, `model`, `params_json`, `terminal_mode`, `tools_json`           |
| `channels`       | Slack-like containers       | `name`, `topic`, `kind`, `profile_id`, `archived_at`                                     |
| `messages`       | User and assistant turns    | `channel_id`, `role`, `content`, `status`, `run_id?`                                     |
| `runs`           | One agent execution         | `channel_id`, `profile_id`, `user_message_id`, `runner`, `status`, `usage_json`, `error` |
| `run_events`     | Ordered append-only log     | `run_id`, `seq`, `type`, `payload_json`                                                  |
| `tool_calls`     | Queryable tool history      | `run_id`, `name`, `input_json`, `output`, `status`                                       |
| `attachments`    | Stored files                | `message_id?`, `filename`, `mime`, `size`, `path`, `extracted_text`                      |
| `scheduled_jobs` | Recurring jobs              | `schedule`, `timezone`, `profile_id`, `channel_id`, `prompt`, `next_run_at`              |
| `job_runs`       | Scheduled execution history | `job_id`, `scheduled_for`, `status`, `run_id?`, `error`                                  |
| `approvals`      | Pending decisions           | `run_id`, `tool_call_id`, `command`, `status`                                            |
| `audit_log`      | Security-relevant actions   | `actor`, `action`, `target`, `detail_json`, `created_at`                                 |

## Phase 1 — Foundation

Goal: a deployable, observable skeleton with a working database, contracts, auth, and a streaming spike.

Target layout:

```text
apps/api          Fastify service
apps/web          React + Vite app
packages/db       Drizzle schema, migrations, queries
packages/shared   Zod contracts and inferred types
```

Status (2026-10-31): implemented and verified locally with Node 22.23.4, pnpm 10.34.9, and Docker Compose. The opt-in live OpenRouter test passed with a real key, producing a short streamed reply.

### 1.1 Workspace and tooling

- [x] Root `package.json`, `pnpm-workspace.yaml`, `.nvmrc` (current Node LTS), `.editorconfig`, `.gitignore` (`node_modules`, `dist`, `.env`, `data/`).
- [x] Strict `tsconfig.base.json` plus per-package configs; workspace packages resolve by name through their built exports.
- [x] ESLint flat config and Prettier; scripts for `lint`, `format:check`, `typecheck`, `test`, and `build`.
- [x] Vitest across workspaces for contracts, database, API, and web logic.
- [x] React Testing Library with the first component test; landed in Phase 2 with the Markdown renderer.
- [x] GitHub Actions: install with a frozen lockfile, then lint, typecheck, test, and build.

Done when a clean clone passes `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

### 1.2 Shared contracts

- [x] `packages/shared`: `HealthResponse`, `ApiError`, and a discriminated `RunEvent` union covering `run.started`, `message.delta`, `tool.requested`, `tool.output`, `approval.requested`, `usage`, `run.completed`, `run.failed`, and `run.cancelled`.
- [x] SSE frame helpers (`id`, `event`, `data`) and cursor types.
- [x] Unit tests for every event variant and for rejecting unknown event types without crashing a stream.

Done when web and API import the same schemas and the union is exhaustively tested.

### 1.3 Database and data directory

- [x] `packages/db`: better-sqlite3 plus Drizzle; initial schema limited to `settings` and the migration journal.
- [x] Boot migration runner over generated SQL; transactional and idempotent.
- [x] PRAGMAs: WAL, `foreign_keys=ON`, `busy_timeout=5000`.
- [x] Data-directory bootstrap for `VEKTOR_DATA_DIR` (default `/data`): `files/`, `workspace/`, and `logs/`, with directory mode `0700`.
- [x] Generate `secrets.key` (32 random bytes, `0600`) on first boot for Phase 2 secret storage; generate and persist `app.instance_id`.
- [x] Settings repository with typed JSON get/set, used for the instance id.
- [x] Tests: migrate an empty database, re-run as a no-op, verify WAL, verify the instance id survives reopen.

Done when a restart reuses the same instance id and migrations are safe to re-run.

### 1.4 API skeleton

- [x] Fastify with env-validated config (`PORT`, `VEKTOR_DATA_DIR`, optional `VEKTOR_ACCESS_TOKEN`, `VEKTOR_ENABLE_DEV_STREAM`).
- [x] Pino JSON logs with request ids and redaction for authorization headers and cookies; request bodies (which may carry provider keys) are never logged.
- [x] `GET /healthz` returns status, version, instance id, DB check, and uptime; `503` when the DB check fails.
- [x] Consistent error envelope, not-found handler, and validation-error mapping.
- [x] Access token: generate `/data/access-token` (`0600`) on first boot; require `Authorization: Bearer` on `/api/*`; keep `/healthz` public. The browser setup flow lands in Phase 2.
- [x] Dev-only SSE endpoint `GET /api/dev/stream` (enabled by `VEKTOR_ENABLE_DEV_STREAM=1`): 20 ordered stub deltas, heartbeats, and resume from `Last-Event-ID` or `?after=`.
- [x] Graceful shutdown: preClose ends open SSE responses, the database closes, and a 10-second watchdog prevents a hung exit.
- [x] Tests with Fastify `inject`: health, 401/200 auth, error shape, SSE ordering, and resume.

Done when `/healthz` is 200, unauthenticated `/api/*` is 401, and logs are JSON with request ids.

### 1.5 Web shell

- [x] Vite + React + Tailwind; shell with a header and disabled placeholders for Chat, Profiles, and Settings.
- [x] Health card polling `/healthz` with version, DB status, instance id, and a clear disconnected state.
- [x] SSE demo panel: connect to the dev stream, render deltas in order, show sequence numbers, and offer reconnect.
- [x] Dev token handling via `VITE_ACCESS_TOKEN` or a browser-local token field; Phase 2 replaces it with the setup flow.
- [x] Loading, empty, and error states; no chat features yet.

Done when the health card and SSE demo work in dev and from the built container.

### 1.6 Provider spike

- [x] `ChatProvider` interface: `streamChat(request)` yields normalized text, tool-call, usage, and finish events, and aborts through `request.signal`.
- [x] Stub provider with deterministic deltas and one fake tool call.
- [x] OpenRouter provider: streaming chat completions, SSE parsing, tool-call argument assembly across chunks, and abort on signal.
- [x] Fixtures: text-only stream, split tool call, usage frame, provider error, and mid-stream disconnect.
- [x] Contract tests replay every fixture through the normalizer; a live OpenRouter test is opt-in and skipped in CI.
- [x] Not wired into chat, runs, or persistence yet.

Done when fixture replays produce the shared event types and a live key produces a short streamed reply.

### 1.7 Docker and Compose

- [x] Multi-stage Dockerfile: build web and API, deploy the API with production dependencies only (`pnpm deploy`), non-root user, writable `/data`, 85 MB image.
- [x] Compose: `127.0.0.1:8787:8787`, named volume `vektor-data:/data`, health check on `/healthz`, restart policy.
- [x] API serves the built web app with SPA fallback, excluding `/healthz` and `/api/*`.
- [x] `.dockerignore` and a reproducible image build.
- [x] README quickstart: `docker compose up --build`, data location, and where the access token lives.

Done when `docker compose up --build` reaches healthy and serves the web shell.

### 1.8 Phase 1 verification

- [x] Clean clone: install, lint, typecheck, test, and build pass.
- [x] Container: health page loads; `/healthz` returns 200; `/api/*` requires the token.
- [x] Persistence: recreate the container and confirm the instance id is unchanged.
- [x] Streaming: dev stream renders in order; disconnect and reconnect resumes from the last sequence.
- [x] Provider: the stub streams text, a tool call, usage, and finish; the live OpenRouter test is skipped without `VEKTOR_OPENROUTER_KEY`.
- [x] Provider live check: the opt-in `src/providers/openrouter-provider.test.ts` passed with `VEKTOR_OPENROUTER_KEY` set, confirming a real short streamed reply.
- [x] Logs: JSON, request ids present, secrets redacted.

Exit criteria: all verification items pass, and health, persistence, auth, and the streaming demo are demonstrated before Phase 2 begins.

## Phase 2 — Core workspace (initial product scope)

Goal: the first useful chat loop.

Status (2026-10-31): implemented and verified locally with Node 22.23.4, pnpm 10.34.9, and Docker Compose. Live OpenRouter API verification passed with a real environment key: model listing, streamed reply, message persistence, event replay, and cancellation. Phase 2 signed off by the user's instruction to continue onto Phase 3.

### 2.1 Settings and provider

- [x] `ProviderService` resolves the OpenRouter key from `VEKTOR_OPENROUTER_KEY` first, then from an AES-256-GCM value in `settings` encrypted with `secrets.key`. The environment key wins, and stored keys are never returned by the API.
- [x] Settings API: `GET /api/settings`, `PUT /api/settings` (write/clear key, default model), and `POST /api/settings/provider/test`, which fetches and caches the model list.
- [x] Settings screen with key entry, clear stored key, default model, connection test, and profile editors.
- [x] Stub provider fallback when no key is configured, so the workspace is usable before setup.

### 2.2 Profiles

- [x] Profiles table and repository, a default profile on first boot, CRUD routes, archive instead of hard delete, and a `409 last_profile` when archiving the last active profile.
- [x] Header switcher applies the selected profile to the active channel; editors cover prompt, model, temperature, max tokens, color, and terminal mode (stored now, enforced in Phase 4).

### 2.3 Channels and direct conversations

- [x] Channels table and repository with `kind` (`channel` | `dm`), topic, profile, timestamps, and archive.
- [x] Sidebar with channel and direct sections, create/rename/archive, and a persisted active channel.
- [x] Flat timelines keyed by `messages.channel_id`; a separate `conversations` table was not needed.

### 2.4 Messages, runs, and replay

- [x] `messages`, `runs`, and `run_events` tables; `POST /api/channels/:channelId/messages` stores the user turn and starts a run.
- [x] `RunManager` streams provider events into the ordered log and creates the assistant message on completion, failure, or cancellation; interrupted runs are marked failed on boot.
- [x] Paginated history (`before`, `limit`) with the channel's `activeRun` in the response.
- [x] `GET /api/runs/:runId/events` replays persisted events and follows live events from `Last-Event-ID` or `?after=`, deduping by sequence.
- [x] `POST /api/runs/:runId/cancel` and `POST /api/runs/:runId/retry`; retry removes the previous assistant message and reuses the user turn.
- [x] Reload mid-stream: the client subscribes from sequence 0 when `activeRun` is present and replays the same output.

### 2.5 Web workspace

- [x] Token gate with browser-local storage and 401 handling; bootstrap loads settings, profiles, and channels and creates "General" on first run.
- [x] Composer with optimistic user message, Enter to send, Shift+Enter for newlines, stop, and regenerate.
- [x] GFM Markdown through `react-markdown` with `rehype-sanitize`, `rehype-highlight`, and a copy button per code block.
- [x] Live run panel with tool calls and usage, bounded SSE reconnect, and clear error states.

### 2.6 Verification

- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- [x] API tests cover settings key handling, profile/channel CRUD, send/stream/persist/replay, pagination, retry, and cancellation.
- [x] Web tests cover SSE parsing and Markdown rendering/sanitization with React Testing Library and jsdom.
- [x] Local production-build smoke test with the stub provider.
- [x] Docker image built and verified: settings, channel creation, streamed reply, and conversation intact after a container restart.
- [x] Live OpenRouter check with a real key (`VEKTOR_OPENROUTER_KEY`): the settings screen's provider-test API returned 424 models; a new profile and channel produced the streamed reply `**Live check passed**`; persisted history matched the reply, and cursor-based event replay matched the original events. A second in-flight provider request was cancelled successfully and its cancelled state persisted.

Verification note (2026-10-31): these live checks used the production API on loopback with an isolated temporary data directory. Cancellation was exercised while waiting for provider output; live cancellation after text deltas was not verified. The API suite passed 29 tests; its opt-in live test was skipped in that separate run because no key was supplied to the test process. The live provider test passed separately earlier in this session. No browser interaction with the settings screen was performed during this live check.

Exit criteria: configure a key, create a profile, create a channel, receive a streamed Markdown answer, stop it, reload, and find the conversation intact. Earlier stub-provider and Docker checks cover the workspace and restart behavior; the real-key API checks above complete the live-provider verification.

## Phase 3 — Files and context

Status (2026-10-31): implemented and signed off by the user's instruction to start Phase 4. Local verification passes lint, typecheck, tests (70 passed at Phase 3 completion; the opt-in live OpenRouter test skipped), and production build. Docker build, production API smoke checks, and container restart persistence all pass.

- [x] File uploads and local storage: authenticated multipart uploads, private UUID-named originals in `/data/files`, attachment metadata and message links in SQLite, and an additive migration preserving Phase 2 data.
- [x] Image paste and drag-and-drop, multi-file selection, attachment-only sends, and upload/error feedback.
- [x] UTF-8 text and source-code input, PDF/DOCX text extraction in workers with a 128 MB JavaScript heap limit and 15-second deadline, explicit rejection of scanned PDFs without text, corrupt/unsupported files, and oversized extraction results.
- [x] Authenticated image previews, extracted document/text previews, original downloads, and historical attachment links.
- [x] Per-channel include/exclude controls persisted across reloads and restarts. Excluded attachments do not enter future context; earlier conversation text may still quote them. Removal deletes the original, extracted text, and links; active runs must stop before removal.
- [x] Server-side pre-send context estimates, model context window and output reservation, explicit confirmation before omitting old history, and persisted run estimates displayed beside actual provider usage when available.

Context policy: assemble the profile prompt, up to 100 recent completed messages, current message, and selected attachments. Use cached model metadata for context windows and image capability; otherwise label an 8,192-token fallback. Estimate text with `cl100k_base` plus message overhead and reserve 4,096 tokens per image. These are estimates, not provider-exact counts, especially for images and non-OpenAI models. Reserve the profile's max output tokens and pass that setting to OpenRouter. Propose dropping oldest history with explicit consent; reject inputs if the prompt and files alone do not fit. Never silently truncate the current prompt or attachments. Retry assembles only history preceding the original user turn, reuses that turn's files that remain included, and excludes later turns.

Limits: 25 MB per file and 250 MB per channel by default, configurable through `VEKTOR_MAX_FILE_BYTES` and `VEKTOR_CHANNEL_FILE_BYTES`; 50 files per channel, 40 megapixels per image, 200,000 extracted characters per file, and 500 PDF pages. At most two uploads process concurrently, with one per channel. The PDF dependency raises the minimum supported Node version to 22.13.

Verification: tests cover real PDF/DOCX fixtures, no-text PDFs, invalid images and UTF-8, upload/storage limits, authenticated content access, inclusion/exclusion, inline image provider payloads, estimate/run agreement, truncation consent, retry boundaries, upgrade from Phase 2, and restart persistence. Web component tests cover selection, paste/drop, previews, file inclusion, budget confirmation, stale estimates, and preserving drafts on errors. Docker smoke checks exercise the built web asset, PDF worker extraction, image preview authentication, exclusion changing the estimate, and a streamed run with a matching saved estimate. Restarting that container preserves both original files, extracted text, inclusion choices, message links, saved estimates, and chat history. Live OpenRouter image/document requests and manual browser interaction were not performed for this phase.

Exit criteria: attach a PDF and an image, see previews, include only one of them, and see an accurate token estimate before and after sending.

## Phase 4 — Terminal permissions and runtime controls

Status (2026-10-31): implemented and signed off by the user's instruction to continue onto Phase 5. Verification passes lint, formatting, typecheck, production build, 93 automated tests at Phase 4 completion (one opt-in live OpenRouter test skipped), and Docker runtime/restart checks.

- [x] No-terminal mode: no terminal definition is sent to the provider; unsolicited calls are rejected and audited. Terminal access also requires `terminal` in the profile's enabled tools.
- [x] Basic terminal guardrail: direct execution of `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `mkdir`, and `touch` with restricted options, workspace boundary checks, rejection of symlink paths and non-regular files, and no shell/interpreter access.
- [x] Full-access mode: profile warning and acknowledgement, exact command/argument/cwd approval before every command, durable pending/approved/denied/cancelled decisions, and a server-side permission recheck immediately before execution. Approvals resolve once and cannot be reused after cancellation or restart.
- [x] Bounded provider/tool loop: OpenRouter tool definitions, correlated assistant tool calls and results, at most eight rounds/eight calls per round, cumulative usage, context/output checks, and a run deadline covering streaming, commands, and approval waits.
- [x] Per-channel run history, persisted tool input/output/status and event timelines, global active-run cancellation, retry from historical runs with context review, and a paginated durable audit viewer. Profile permission changes, command requests/denials/execution, approvals, run outcomes, recovery, and global stop/resume are audited.
- [x] Global emergency stop: latch the stop flag, abort/finalize active runs, cancel pending approvals, kill supervised process groups, and reject new sends/retries until explicit resume. The latch survives restart. Phase 5's scheduler must use the same start gate; no scheduler exists yet.

Execution policy: basic mode is a restricted command guardrail rather than an arbitrary shell with a changed working directory. Full mode requires approval for all commands, avoiding reliance on a destructive-command blacklist that shell wrappers could bypass. Both modes use a fresh environment containing only `PATH`, `HOME`, `TMPDIR`, and `LANG`, a private umask, detached process groups, a supervisor that terminates the group if its API pipe disappears, and known-credential redaction before output persistence. Commands default to a 15-second timeout; basic caps at 15 seconds, full permits up to 60 seconds. Output is capped at 64 KiB and overflow terminates the group. Runs default to a two-minute deadline, configurable with `VEKTOR_RUN_TIMEOUT_MS` (one second to ten minutes).

Boundary: Docker execution uses the unprivileged container account. A directly launched backend executes on its host account; the UI identifies the environment. Basic path checks are not kernel filesystem isolation and cannot defend against hostile concurrent filesystem changes or pre-existing hard links. Full-access commands can alter any path the backend account can access; approval is not privilege escalation. Process-group cleanup does not promise containment of deliberately daemonized/new-session processes in full mode. Windows requires a POSIX/Docker backend. Hardened OS sandboxing remains outside this guardrail implementation.

Verification: tests exercise traversal and symlink rejection, restricted options/tool switches, stripped environment, split-output secret redaction, output/time limits, shell-child process-group termination, supervisor pipe loss, approval/denial and revocation, one-time decisions, immediate cancellation of an uncooperative provider with partial output preserved, repeated-call limits, run deadlines, restart recovery without command replay, emergency-stop persistence, and migration from Phase 3. UI tests cover approval/denial, stop/resume, exact command display and host/container warnings, historical tool input/output, retry, audit pagination, and full-access acknowledgement. Live OpenRouter tool calls and manual browser interaction are not part of this verification pass.

Packaged verification: a disposable production container with a local OpenRouter-compatible fixture exercised no-terminal denial, basic `pwd`, rejection of `/data/access-token` outside the workspace, approval-gated deletion of a test marker, tool-result correlation, cumulative usage, and persisted audit records. Emergency stop ended an active shell and its `sleep` child in 7 ms, marked the run/tool cancelled, and blocked new sends. After restart, the stop latch, tool history, and audit records persisted; no command replayed, and explicit resume cleared the latch without starting work. The disposable container and test data were removed afterward.

Exit criteria: a basic-mode command cannot escape the workspace and is audited; a full-mode destructive command blocks on approval; emergency stop ends a long-running command within a few seconds.

## Phase 5 — Scheduling

Status (2026-11-01): implemented and signed off by the user's instruction to follow the recommended closeout and proceed to Phase 6 after checks pass. Reverification passes 137 tests (one opt-in live OpenRouter test skipped), lint, formatting, typecheck, production build, and Compose validation. Migration/schema consistency and real-clock Docker timer/restart checks were demonstrated on 2026-10-31 as recorded below.

- [x] Authenticated recurring-job CRUD, explicit profile/channel/prompt selection, enabled/paused state, soft deletion retaining history, and a maximum of 100 non-deleted jobs.
- [x] Five-field numeric cron and a deterministic friendly-input helper: hourly, daily, weekdays at 9am, weekly on monday at 9am, and evenly dividing minute/hour intervals. Upcoming occurrences and the normalized cron are previewed before saving.
- [x] Persist each job's IANA time zone independently of the backend/browser zone; store due times as UTC instants and display them in the job's zone. Tests cover offset changes, spring-forward gaps, and repeated fall-back times.
- [x] Durable execution history with source (scheduled, catch-up, manual), scheduled instant, run ID, running/completed/failed/cancelled/skipped states, approval-wait indication, error/reason, and stable cursor pagination. Failures and cancellations are delivered into active target channels; invalid/archived targets disable the job until corrected.
- [x] Normal run-manager execution and channel delivery, including streaming, current profile permissions, terminal approvals, cancellation, audit, and context/output budgets. The chat refresh discovers scheduled runs and subscribes to their streams while the channel is open.
- [x] Restart-safe scheduling: persisted next-run times, database scheduler/job leases, unique occurrence records, atomic advancement plus run/job-history creation, and no automatic replay of an interrupted committed run.
- [x] Per-job pause/resume, global scheduler pause/resume, and manual Run now with history. Global emergency stop gates automatic and manual launches, cancels active scheduled runs/approvals, and remains latched after restart.

Timing policy: one-minute cron resolution, with a one-second tick by default. An overdue occurrence at startup, or a live tick delayed by at least a minute, is missed. Default behavior records one skipped summary and advances to the next future occurrence. Opt-in catch-up coalesces missed occurrences into one attempt labelled with the first unserved due time; it does not run every missed occurrence. Overlap with the same job or any active run in the target channel is skipped, not queued. Paused/stopped intervals are not replayed on resume, even for catch-up jobs. Per-job resume recalculates a future due time; manual execution does not change the recurrence. Pausing/deleting a job does not cancel its already active run.

Context policy: scheduled runs include the current profile prompt and saved job prompt, with no attachments or channel history by default. Channel history and automatic omission of older history require separate explicit job settings. Context policy persists on the run so ordinary retries cannot silently add channel history. Scheduled full-access tool requests wait for the same user approval as chat and can fail on the existing run deadline; scheduling never grants unattended approval.

Restart/concurrency boundary: a firing is recorded and the recurrence advanced in the same SQLite transaction as its user message and run record. If the backend dies after commit but before execution, recovery marks the run/history failed rather than replaying commands. Leases and unique `(job, occurrence)` keys prevent duplicate claims; Vektor remains a single-backend application, not a supported multi-server worker deployment. External side effects are not claimed to have exactly-once semantics.

Verification: tests cover friendly/cron validation, UTC and Perth/NY zone behavior, DST gaps/folds, an actual timer tick, CRUD/authentication, pause/resume, catch-up/missed policies, overlap/channel contention, expired leases and competing scheduler claims, stale preparation after edits or pause/resume, manual runs and pagination, archived targets, provider/context failures, scheduled approvals, cancellation/emergency stop, interrupted dispatch recovery, and repeated retries preserving context scope. UI tests cover schedule previews, create/edit, explicit context options, job/global pause, invalid input, manual-run blocking, history/approval display, channel navigation, and retained deleted-job history.

Packaged verification: a disposable production container using the deterministic provider created a future UTC cron job and a paused job, executed one manual run without changing the recurrence, and restarted before the scheduled due time. The persisted job fired exactly once on the real clock, delivered a second assistant message into its channel, and advanced its next due time; the paused job had no executions. A second restart preserved manual/scheduled history, global scheduler pause, and emergency stop. A valid manual request was blocked while stopped; explicit resume cleared the controls without replaying work. The disposable container and data were removed afterward. Live OpenRouter calls and manual browser interaction were not performed for this phase.

Exit criteria: create a job, restart the container, and see it fire on schedule with history and a delivered message; a disabled job does not fire.

## Phase 6 — Desktop packaging

Status (2026-11-01): implemented and signed off by the user's instruction to start Phase 7. Linux native packaging and end-to-end verification are complete; macOS/Windows packaging and desktop-environment-specific tray/notification behavior have not been manually verified. Follow-up composer/header refinements move context and run/file counts to a slim footer, replace attachment text with a plus button, and integrate emergency stop and runtime details into the main header. All 29 UI tests, lint, formatting, typecheck, web build and rebuilt Linux package pass after these refinements.

- [x] Tauri 2 wraps the existing bundled React frontend, without a backend sidecar. Root desktop dev/build/check commands and Linux native CI compile/test checks are included.
- [x] First-launch local backend URL setup, five-second health check, explicit save/open, saved-connection fallback while offline, URL validation, and credentials stored separately by backend origin. Native HTTP handles authenticated requests, multipart uploads, streaming SSE and cancellation without broadening API CORS. Redirects are disabled, and native HTTP capabilities allow only loopback hosts.
- [x] Opt-in native notifications with OS permission and a test notification. A native three-second monitor covers terminal statuses across all channels while unlocked, including when the window is hidden; the initial successful poll establishes a baseline without replaying old history. Notifications contain status only. The latest-30-run polling window can omit notifications during a long outage or a large burst; durable history remains authoritative.
- [x] Native tray actions open the app/connection setup, pause/resume the scheduler, activate emergency stop, and quit the desktop process independently of Docker. Tray requests use the unlocked credential in memory; locking clears it. Errors restore the window and display a notice. Window close hides to tray after successful tray initialization; Linux requires an AppIndicator host. Scheduler resume never clears emergency stop.
- [x] Backend connection screen shows database/version/instance health and authenticated data/workspace directory paths plus the backend execution environment. Existing host/container terminal permission warnings remain in the shared runtime UI.
- [x] README covers Docker setup/token retrieval, desktop prerequisites, local development, native package commands, tray/notification behavior, data ownership, and platform validation limits. Generated native build artifacts are excluded from Git, formatting/lint scans, and Docker build context.

Verification: 144 TypeScript tests plus four native tests pass (one optional live OpenRouter test is skipped), with lint, formatting, typecheck, web/API production build, native formatting, locked native tests, and Linux `.deb` packaging. Native tests parse the shipped HTTP permission patterns and verify loopback matching, URL validation, tray action paths, and completion-notification transitions/deduplication. Frontend/API tests cover connection success/failure, token separation, native transport bodies/signals, notification permission denial/grant, and authentication for backend filesystem metadata.

Packaged verification: the actual bundled Linux app was automated through Tauri/WebKit WebDriver against a disposable production Docker backend using the deterministic provider. It checked/saved the backend, unlocked, created a channel, rendered streamed output, uploaded a text attachment through native multipart HTTP, and displayed `/data` and `/data/workspace` as container paths. The exported native D-Bus tray menu paused/resumed the actual scheduler and emergency-stopped an active run, which persisted as cancelled. Restart preserved emergency stop and history; scheduler resume did not clear the stop latch. A native window-close event hid the app, a completed run delivered a notification to a controlled D-Bus notification sink while hidden, and the tray restored the window. The final optimized release binary also passed health/data display, failed-connection recovery, lock, blocked tray actions while locked, and native Quit leaving Docker healthy. Test credentials/connection storage and disposable processes/container were cleared afterward. These are automated native integration checks, not a manual assessment of OS notification appearance. No live OpenRouter call was made.

Exit criteria: the desktop app connects to a Docker backend, shows health, delivers a notification on run completion, and exposes scheduler pause and emergency stop from the tray.

## Phase 7 — Hardening

Status (2026-11-01): implemented and signed off by the user’s instruction to continue to Phase 8. Verification passes 162 TypeScript tests plus four native tests (one opt-in live OpenRouter test skipped), lint, formatting, typecheck, production build, Linux desktop packaging, migration/schema consistency, Compose validation and a disposable production Docker fresh-volume restore and hard-kill/retry demonstration. No live OpenRouter request or manual browser interaction is required or claimed for this phase.

- [x] Expand permission/isolation tests to cover hard-linked files, FIFOs and replacing a previously checked path with a symlink before execution. Basic paths are revalidated immediately before launch; environment stripping, no-terminal/tool-switch enforcement, approvals, output/deadline limits, process-group cleanup and permission revocation remain covered. Basic mode remains a guardrail rather than a hardened sandbox against concurrent filesystem mutation.
- [x] Offline backup/verify/restore commands use a standalone SQLite backup snapshot and a checked manifest of attachments, workspace files, executable bits, safe relative workspace symlinks, the encryption key and persisted access token. Verification checks hashes, types/parents, SQLite integrity/foreign keys, migration history, instance metadata and referenced attachments. Source/destination nesting, existing backups and populated restore targets are refused. Restore stages/reverifies before promotion; an interrupted promotion prevents startup until restored into a fresh target.
- [x] Server and maintenance commands share an exclusive OS-backed lock through a separate SQLite connection/file. This enforces one cooperating backend or maintenance process per local data directory and automatically releases on process death. The persistent lock file is never unlinked to bypass an owner. Arbitrary external workspace writers must also be stopped for a consistent file snapshot.
- [x] Private JSON file logs with bounded rotation, plus sanitized stdout. Defaults are five files including current, 10 MiB each; Compose also caps Docker's stdout logs. Request serializers omit bodies/headers/query strings, known secrets are redacted before both outputs, old keys remain redacted after rotation, and oversized records become bounded omission records. Provider connection-test errors also respect write-only credential handling. Production Compose disables dev streams by default.
- [x] Authenticated usage report and Settings UI with UTC periods, OpenRouter/demo/historical scopes, per-profile/per-job attribution and retained retry attribution. Usage is persisted on receipt; cumulative frames replace the current call's totals, while separate tool-loop calls add together. Provider-reported zero prices, absent prices and missing usage remain distinct. Cost coverage includes calls/runs without full data and known USD subtotals; historical provider attribution remains unknown. Fixture tests reconcile tokens/prices across retries, multiple calls, duplicate cumulative frames, failures and missing/zero prices.
- [x] [Operations](OPERATIONS.md) documents Docker and host backup/verification, fresh-volume restore, ownership and environment overrides, scheduler/stop behavior, log retention, usage coverage, migrations, pre-upgrade checks and rollback through a pre-upgrade backup. Startup refuses newer/incompatible migration history rather than attempting a downgrade.
- [x] Atomic final run message/status/terminal-event/audit persistence, with publication after commit. Restart recovery transactionally preserves persisted partial output/usage, fails interrupted runs, closes tools/approvals, reconciles job history and writes one terminal event without replay. An injected finalization-storage failure verifies rollback; an actual API SIGKILL test verifies streaming, an approved child process group, another approval wait, scheduled history, retained usage/job attribution, retry and repeated-restart idempotence.

Details: a consistent backup command (SQLite snapshot plus files), restore into a fresh volume, JSON logs with rotation and redaction, per-profile and per-job cost report from OpenRouter usage, and crash-recovery tests that kill the process mid-run.

Packaged demonstration: `scripts/verify-phase7.py` creates only disposable containers and volumes, proves live-backend backup refusal, backs up the stopped backend, verifies through a read-only mount, restores into a new volume, and confirms instance/token/encrypted credentials, attachment bytes, workspace contents, paused jobs and global stop/pause settings. After explicit resume, a scheduled manual execution and a chat run complete and appear under the correct provider/job usage scopes. It then kills the restored container mid-run, restarts immediately with the OS lock released, verifies the interrupted run is failed, and retries successfully. It clears synthetic provider credentials before any execution and removes its own resources. CI runs the same packaged verification.

Exit criteria: restore a backup into a clean volume and resume work; an interrupted run is marked failed and retryable; the cost report reconciles with provider usage.

## Phase 8 — Release builds and update checks

Status (2026-11-01): implementation and local verification are complete. Publication is pending: no tag, registry push, or GitHub Release has been created. The first real release must demonstrate the remote multiarchitecture build, attached provenance, and an older instance’s live update notification before this phase’s publication exit criteria can be signed off.

Goal: GitHub Actions produces the release, and a running Vektor can tell the user when a newer release exists without leaking local data or interrupting work.

- [x] Version has one source of truth: the root package metadata, injected into the API and web build. `/healthz`, the About panel, the Docker image label, and the release tag all report the same value.
- [x] CI keeps running lint, typecheck, test, and build on every push and pull request; tag builds run the same checks before publishing.
- [x] Release workflow on `v*` tags (with manual dispatch): run the full verification, build the API and web artifacts, and configure publication of a multi-arch image to GitHub Container Registry with `x.y.z`, `x.y`, and `latest` tags.
- [x] Image packaging carries OCI labels for version, revision, source, and build date, plus a BuildKit provenance attestation configured by the release workflow (not a claim of separately signed GitHub attestations). The GitHub Release links to the image, release notes, and upgrade instructions.
- [x] `GET /api/update-check` (bearer auth) queries the GitHub Releases API for the repository, compares versions with strict semver, caches the result for 24 hours, and returns current version, latest version, availability, release URL, and publish date.
- [x] Failure handling: 5-second timeout, at most one retry, and quiet degradation for offline, rate-limited (HTTP 403/429), missing, or malformed responses. A failed check never blocks startup, chat, or runs.
- [x] Privacy: public checks add only a `User-Agent` and read release metadata. Private checks additionally send only the explicitly configured read-only GitHub token. No instance id, Vektor access token, provider key, usage data, or data-directory contents leave the machine, and the only outbound host is `api.github.com`.
- [x] Update checking is optional: `VEKTOR_UPDATE_CHECK` and an About-panel switch. Default is one check per 24 hours; "Check now" forces a fresh request.
- [x] UI: current version in the About panel and footer, an "update available" badge with the release link, and upgrade steps (`docker compose pull && docker compose up -d`; the `vektor-data` volume is preserved).
- [x] No automatic download or install in v1. Docker and desktop both notify and link to the release; silent self-update is deferred.
- [x] Tests: semver comparison table (equal, newer, older, prerelease, malformed), fixture GitHub responses (latest, prerelease-only, rate-limited, offline), cache expiry, and opt-out behavior.

Details: repository inspection confirmed `someone6783/Vektor` is private. The planned private-repository exception applies: checks default off and require an optional GitHub token with Contents: read access. Tokens are encrypted using the existing secrets key and never returned. `VEKTOR_GITHUB_TOKEN` can manage the token; `VEKTOR_UPDATE_CHECK=0` enforces opt-out. For public builds, only the User-Agent is sent; for this private build the optional token is sent only to the fixed GitHub release API endpoint, with redirects disabled. No repository visibility change was made. Version comparison uses the `semver` package rather than string comparison. Cached results live in `settings` so a restart does not immediately re-query GitHub, and the timestamp is visible as "last checked". The check is server-side to keep the token out of the browser and to avoid CORS and per-browser rate limits.

Verification: 204 TypeScript tests, three release-script tests and four native tests pass (one opt-in live provider test skipped). Lint, formatting, typecheck, production build, Linux `.deb` packaging, artifact extraction/startup/checksums, Actions syntax and Compose validation pass. The Docker image passes the disposable fresh-volume backup/restore and SIGKILL recovery/retry demonstration. Strict-semver and release fixtures cover caching across service recreation, 24-hour expiry, manual force, prereleases, 403/429/404, malformed/oversized responses, timeout/retry, shutdown, simultaneous callers, opt-out, encrypted credentials and route authentication. UI tests cover versions, write-only credentials, the About switch, forced checks and desktop release links. Release metadata/alias/checksum tests, packaged API/web smoke checks, Linux native checks, Docker recovery checks and Actions syntax validation supplement the normal lint/typecheck/test/build checks. See [release operations](RELEASING.md) for commands and the remaining remote demonstration.

Exit criteria: pushing a `v*` tag publishes a tagged image and GitHub Release with no manual steps; an older running instance reports the newer version within the cache window and links to the upgrade instructions; with no network the instance keeps working and shows "unable to check" instead of an error.

## Phase 9 — Browser use (after v1)

Status (2026-11-01): implemented and locally verified at the user’s explicit request while Phase 8 publication remains pending. Browser design and operations are documented in [BROWSER.md](BROWSER.md). Verification passes 252 TypeScript tests, three release-script tests and four native tests (one opt-in live provider test skipped), lint, formatting of tracked source, typecheck, production build, Linux desktop packaging, archive smoke checks and Actions/Compose validation. The non-root Docker image passes the deterministic browser form/approval/stop demonstration and the existing backup/restore/SIGKILL/retry checks. An actual API SIGKILL/restart separately proves Chromium exit, abandoned-cookie removal, cancelled approval and no replay. No personal browser attachment or arbitrary external-site mutation is used for the demonstration.

Goal: let an explicitly enabled profile operate a managed browser, with navigation, page understanding, and approved interactions visible in the run timeline.

Dependencies: first usable release (Phases 1–8), including Phase 4's approval/stop controls and Phase 7's backup, logging, and recovery work. The user explicitly authorized starting Phase 9 before the first published-release demonstration; that Phase 8 follow-up remains tracked separately.

- [x] Add a browser-controller interface for navigation, tabs, DOM/accessibility snapshots, screenshots, element selection, click, typing, scrolling, and bounded waits. Select and pin the browser engine/controller during this phase's design review.
- [x] Add per-profile browser access: off by default, observation-only, or interactive. Enforce capabilities in the backend; terminal mode does not grant browser access, and no-terminal profiles can only use browser capabilities explicitly enabled for them.
- [x] Run a dedicated browser session per run by default. Keep it separate from the user's personal browser; offer explicitly managed persistent sessions only with clear cookie/storage ownership, disconnect, and reset controls.
- [x] Define allowed origins and redirect checks. Block private-network, loopback, metadata-service, and local-file access by default; require an explicit scoped grant for local application testing. Apply the same network rules to subrequests and downloads, not just the initial URL.
- [x] Distinguish observation from actions: observation mode exposes navigation and extraction but no form submission or mutation controls. Explain that navigating to an external site still makes network requests; it is not a guarantee that the site has no side effects.
- [x] Route submissions, posting/sending, purchases, account changes, and other consequential actions through Vektor approvals bound to the current origin, target, and action. Expire or re-confirm approval when the page/target changes; never reuse approval for a different action.
- [x] Support uploads and downloads only through approved attachment/workspace paths, with file size/type limits and previews. Do not expose backend keys, arbitrary host files, or personal browser credentials to page content.
- [x] Show browser actions, origin, relevant screenshots/snapshots, results, and errors in the existing timeline. Treat page content as untrusted input; it cannot change permissions or approve its own instructions. Apply artifact retention and redaction controls.
- [x] Add user takeover, pause, cancellation, bounded action/time limits, and emergency-stop cleanup of the browser session. Scheduled jobs must declare their browser capability and pause for approval rather than assuming unattended interaction is allowed.
- [x] Test deterministic local pages for navigation, extraction, interaction, redirects/network boundaries, injection attempts, file boundaries, denied actions, approval expiry, session cleanup, and restart behavior.

Exit criteria: a profile can inspect a test page, fill a form in interactive mode, and pause before submission; denial prevents submission, approval permits only that action, and emergency stop terminates the session. Observation-only mode cannot submit, and unapproved network/file targets remain blocked.

## Phase 10 — Computer use (after v1)

Goal: let an explicitly enabled profile interact with applications through screenshots, pointer actions, and keyboard input in a controlled desktop session.

Dependencies: Phase 9 plus a reviewed desktop-session isolation and permission design. The Phase 6 Tauri shell alone does not grant OS control or turn a remote Docker backend into a host automation agent.

- [ ] Introduce a computer-session interface for screenshots, screen geometry, pointer movement/click/drag/scroll, keyboard input, and application/window selection, with a capability check for the chosen model's image/tool support.
- [ ] Start with an isolated virtual desktop/container or VM with its own display, files, and credentials. Host-desktop attachment is a separate opt-in milestone requiring a local bridge, explicit OS permissions, a visible connected-session indicator, and a revocable grant.
- [ ] Add per-profile computer access off by default, separately from browser and terminal permissions. Scope grants to a particular desktop/session and supported applications; never infer permission to control the whole host from full terminal access.
- [ ] Provide a user-visible session preview, action target, pause/takeover, and an action timeline with before/after screenshots. Validate screen coordinates and discard queued actions when display geometry, session, or foreground target changes.
- [ ] Require confirmation for consequential actions, including sending/submitting, installing software, changing security/account settings, and deleting files. Handle login, password, payment, and other sensitive fields through user takeover without logging keystrokes or putting secrets into model-visible screenshots.
- [ ] Keep clipboard, filesystem transfer, and external network access disabled unless separately granted. Reuse approved attachment paths and download limits, and define screenshot access, retention, deletion, and redaction behavior.
- [ ] Enforce bounded action/time budgets, cancellation, and emergency stop that releases held keys/buttons, clears queued input, revokes control, and terminates the isolated session. Restart must not resume clicks or keystrokes automatically.
- [ ] For scheduled computer tasks, require an isolated session and explicit unattended policy; pending human approval pauses the job. Do not allow scheduled tasks to seize the user's active desktop implicitly.
- [ ] Test against controlled desktop applications, including scaling/multiple-display changes, stale targets, permission denial, prompt injection in screenshots, sensitive-field takeover, cancellation during drag/typing, and restart recovery.

Exit criteria: a profile completes a benign task in an isolated test desktop with visible actions; a consequential step pauses for approval, revoked access prevents further input, and emergency stop halts input and releases keys/buttons. The user's real desktop remains untouched unless a separate host-control grant was explicitly made.

## Phase 11 — Codex harness and hybrid runners (late plan, after v1)

Goal: add the Codex agent harness as an optional runner while retaining Vektor's native OpenRouter loop, workspace UI, permissions, and execution history. This makes the existing hybrid-runtime plan in D4 concrete.

Dependencies: Phase 8's release/versioning foundation and Phases 9–10's capability contracts. Integration is scheduled after browser/computer use; the first Codex milestone may expose only capabilities whose enforcement and event mapping have been verified.

Integration proposal: prefer a locally managed Codex app-server connection over stdio for the interactive Vektor experience. Official documentation describes app-server's thread/turn lifecycle, streamed events, interruption, and approval requests, while the Codex SDK and `codex exec` cover other programmatic/job workflows. Re-evaluate the supported interface and authentication requirements when implementation starts. Sources: [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform).

- [ ] Introduce a versioned runner interface with explicit `native` and `codex` identities; migrate stored runner values/shared contracts and reserve a generic `cli` adapter for other future integrations. Provide per-profile selection and an explicit per-run override without silently switching runners on failure.
- [ ] Add Codex installation/version discovery, a compatibility probe, process/session health, and setup diagnostics. Document local and Docker packaging without requiring users to install Codex for the native runner.
- [ ] Add separate Codex authentication/account configuration using officially supported mechanisms. Keep credentials write-only/protected, surface missing access and usage limits, and distinguish Codex billing/model availability from OpenRouter. Do not assume an OpenRouter key or a particular subscription grants Codex access.
- [ ] Map Vektor conversations and runs to Codex thread/turn identifiers. Persist the mapping and lifecycle cursor, support deliberate resume/reconnect, and prevent duplicate turns or command replay after interruption/restart.
- [ ] Normalize streamed messages, tool calls/output, proposed file changes/diffs, approval requests, usage, errors, and completion into Vektor's timeline/audit contracts. Preserve identifiers for traceability and label provider metrics that are unavailable rather than fabricating them.
- [ ] Translate Vektor's filesystem/network permissions and approval decisions into supported Codex controls. Do not equate similarly named sandbox modes with identical guarantees. Reject unsupported mappings or disable the capability; never widen permissions or approve a harness request automatically to make a run proceed.
- [ ] Initially reject the Codex runner for no-terminal profiles unless the integration can prove command execution is disabled. Basic mode must preserve Vektor's effective restrictions; expose it only after verifying enforcement. Full-access command/file-change approvals must remain visible and attributable in Vektor.
- [ ] Supply only explicitly selected conversation/file context and scoped workspace access. Define which layer owns compaction/context limits, distinguish harness estimates from actual usage, and keep excluded attachments and backend credentials out of implicit context sources.
- [ ] Reuse browser/computer controllers only through capability-checked adapters that preserve Phases 9–10's session boundaries and approvals. A harness runner must not gain browser, computer, network, integration, or file access merely because the underlying tool exists.
- [ ] Bridge cancellation and emergency stop to turn interruption plus supervised process/session cleanup. Resolve pending approvals as cancelled, preserve the global stop latch, and require explicit action before resuming interrupted work. Scheduled Codex jobs use the same execution gate and history as native jobs.
- [ ] Add protocol fixtures and compatibility tests for event ordering, reconnect/duplicate delivery, approval/denial, unsupported permissions, missing/expired authentication, cancellation, process death, and version drift. Re-check official interfaces before each supported harness upgrade.

Exit criteria: the same Vektor workspace can run a native conversation and a Codex-backed task with clearly labelled runner/model/auth state, streamed progress, reviewable file/tool actions, durable history, and working cancel/emergency stop. Unsupported permission combinations are rejected before execution; Codex disconnect or unavailability leaves the native runner usable without automatically resubmitting the task.

## After v1 — External service integrations

Planned, not part of the first usable release. Vektor should support adding optional integrations with third-party services such as Spotify, Gmail, and Apple Calendar.

- Introduce a provider-neutral integration interface for authentication, capabilities, rate limits, and error handling.
- Add secure OAuth credential storage and per-integration permission scopes, with the ability to disconnect or revoke access.
- Expose enabled services as permissioned tools that profiles and scheduled jobs can use, with every request recorded in the audit log.
- Start with Spotify, Gmail, and Apple Calendar as the initial integration targets, subject to API and platform availability.
- Keep integrations optional and isolated so the core local-first workspace works without any connected external accounts.

Exit criteria: a user can connect and disconnect an integration, review its granted permissions, use an approved capability from a profile or scheduled job, and see the request in the audit history.

## Explicitly deferred

- Browser use/automation until Phase 9 (planned after v1).
- Computer use and desktop automation until Phase 10 (planned after v1).
- Codex harness and hybrid-runner integration until Phase 11 (late plan, after v1).
- Multi-user accounts and collaboration.
- Visual workflow builder.
- Distributed microservices.
- Large-scale worker autoscaling.
- Native video understanding.
- External service integrations, including Spotify, Gmail, and Apple Calendar.
- Marketplace/plugin ecosystem.
- Complex multi-agent planning graphs.

Also deferred: conversation threads and reactions, OCR for scanned PDFs, native providers other than OpenRouter in v1, and a bundled desktop backend. Browser use, computer use, and the Codex harness are now scheduled post-v1 work, rather than permanently excluded capabilities; none changes the first usable release definition below.

## Definition of the first usable release

The first usable release is complete when a user can:

1. Start Vektor with Docker.
2. Configure an OpenRouter key.
3. Create and switch between profiles.
4. Choose no-terminal, basic-terminal, or full-access mode.
5. Chat with a profile and receive streamed responses.
6. Paste or upload supported documents and images.
7. See active runs, tool calls, and context usage.
8. Cancel a running agent.
9. Create, pause, and inspect a recurring scheduled job.
10. Restart the container without losing data.
11. See the installed version and whether a newer release exists.

Phase mapping: item 1 → Phase 1; items 2, 3, 5 → Phase 2; item 6 → Phase 3; item 7 → Phases 3–4; items 4, 8 → Phase 4; item 9 → Phase 5; item 10 → Phases 1 and 7; item 11 → Phase 8.

## Risks

- **Sandbox expectations.** Basic mode is a guardrail; only the container boundary is real isolation. The UI and docs must say this, and Phase 7 must test the claim.
- **Provider variance.** OpenRouter models differ in streaming, tool-call formatting, and vision support. Fixtures and capability checks are required, plus graceful "model does not support X" errors.
- **SQLite contention.** Event streaming is write-heavy; keep a single writer, batch deltas, and use WAL.
- **Scheduler duplicates.** Restarts and multiple instances can double-fire jobs; the lease and `next_run_at` update must be atomic.
- **Secret leakage.** Tool output and error messages can echo environment variables; redact before persisting or logging.
- **Context drift.** Long conversations and large attachments can silently truncate; the usage meter and inclusion controls must reflect what is actually sent.
- **Desktop divergence.** Full-access commands on the host are more dangerous than inside Docker; the desktop build needs its own warning and approval defaults.
- **CLI adapter drift.** External CLIs change flags and event formats; pin versions, detect capabilities, and fail closed. Switching to the native runner requires an explicit choice rather than automatic task resubmission.
- **Browser boundaries.** Pages can redirect, contact private services, expose session cookies, or contain instructions aimed at the agent. Network/action grants, separate sessions, scoped approvals, and artifact controls must be enforced outside the model.
- **Computer control.** Stale coordinates, focus changes, sensitive screenshots, and held input can affect the wrong application. Begin with isolated sessions; host control requires explicit OS grants, visible takeover, and tested stop behavior.
- **Harness policy mismatch.** Codex permissions, authentication, event schemas, and compaction may differ from Vektor's. Verify effective restrictions, pin supported interfaces, and reject unsupported configurations instead of widening access or silently changing runners.
- **Update checks.** GitHub's API is rate-limited and may be unreachable; checks must be cached, optional, and must never block startup or reveal local data.

## Decision log

| Date       | Decision                                                                                                                                                  | Status   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 2026-10-31 | Plan v0.2: added Phase 0 proposals, Phases 1–2, architecture, data model, risks                                                                           | Draft    |
| 2026-10-31 | D1: TypeScript monorepo — React/Vite, Fastify, SQLite/Drizzle, shared Zod contracts                                                                       | Accepted |
| 2026-10-31 | D4: hybrid runtime — Vektor-owned loop in v1, CLI adapter after v1                                                                                        | Accepted |
| 2026-10-31 | D6: channels plus DMs with flat timelines; threads deferred                                                                                               | Accepted |
| 2026-10-31 | D11: basic mode is a container-boundary guardrail, documented as such                                                                                     | Accepted |
| 2026-10-31 | D14: GitHub Actions publishes releases; Vektor checks GitHub Releases for updates, no auto-install                                                        | Accepted |
| 2026-10-31 | D2, D3, D5, D7–D10, D12, D13: remaining Phase 0 defaults                                                                                                  | Accepted |
| 2026-10-31 | OCR for scanned PDFs deferred; PDFs without a text layer are rejected with a clear message                                                                | Accepted |
| 2026-10-31 | Auth: single local access token, no accounts                                                                                                              | Accepted |
| 2026-10-31 | Plan v0.4: all Phase 0 decisions accepted; Phase 1 expanded into a task checklist                                                                         | Accepted |
| 2026-10-31 | Plan v0.6: add post-v1 browser use (Phase 9), computer use (Phase 10), and late Codex harness/hybrid runners (Phase 11); preserve the first-release scope | Planned  |
