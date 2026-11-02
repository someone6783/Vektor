# Vektor operations

For desktop local-service installation, tray shutdown and separate Docker API/web
containers, see [Installation](INSTALLING.md).

Vektor supports one backend per local data directory. Stop the backend before
backup, restore, volume maintenance, or manual database changes. A separate SQLite
connection holds an exclusive OS lock on `.vektor-lock.db` for the server's lifetime
and during maintenance. A second server or maintenance command fails while it is
held. The OS releases it after a crash; never delete the lock file to bypass it.
The main database continues to use WAL. Network filesystems and distributed workers
are not supported.

## Back up a Docker installation

Create a dedicated backup volume once and give the backend user access:

```sh
docker volume create vektor-backups
docker compose run --rm --no-deps --user 0 -v vektor-backups:/backups vektor \
  sh -c 'chown 1001:1001 /backups && chmod 700 /backups'
```

Stop Vektor, create a uniquely named snapshot, and restart:

```sh
docker compose stop vektor
docker compose run --rm --no-deps -v vektor-backups:/backups vektor \
  node dist/maintenance/cli.js backup /backups/pre-upgrade-2026-11-01
docker compose start vektor
```

Choose a new destination name each time. Existing backups are never intentionally
overwritten. Keep backups outside the source data directory; nested destinations
are rejected. Also stop external editors or other processes writing the workspace.
The data lock coordinates Vektor processes, not arbitrary filesystem writers.

A backup is a directory containing:

- `manifest.json`: format version, application version, timestamp, instance ID,
  ordered paths, file sizes, SHA-256 checksums and executable/link metadata.
- `vektor.db`: a standalone SQLite backup snapshot, including migrations, messages,
  profiles, run events, scheduler history, usage, audit entries and encrypted settings.
- `secrets.key` and, when present, `access-token`.
- `files/` and `workspace/`, including empty directories and executable files.

Backup directories are private (`0700`); regular data files are `0600`, and executable
workspace files are `0700`. Workspace symlinks are preserved without following them
only when their relative targets stay within the workspace. External/absolute links,
devices, sockets and FIFOs fail the backup. Remove or relocate unsupported entries
before trying again. Logs, WAL/SHM files, locks, environment variables and external
services are not included. Database audit history is included.

Backups contain both encrypted settings and their decryption key, plus all conversation
and attachment data. Keep them private and copy them to independent protected storage;
a second volume on the same disk is not protection against disk loss. Checksums detect
corruption, not malicious replacement of the backup and its manifest.

Verify a backup without starting the backend or writing into the backup volume:

```sh
docker compose run --rm --no-deps -v vektor-backups:/backups:ro vektor \
  node dist/maintenance/cli.js verify /backups/pre-upgrade-2026-11-01
```

Verification checks manifest paths/types/checksums, the encryption key's size,
SQLite integrity and foreign keys, migration compatibility, instance metadata and
the presence/size of every attachment referenced by the database. A partial backup
uses a `.partial-<id>` directory and is not promoted until verification succeeds.

## Restore into a fresh volume

Restore never overwrites a populated data directory. Use a new volume, preserving
the original installation until the restored one is verified:

```sh
docker volume create vektor-restored-data
docker run --rm -v vektor-restored-data:/data -v vektor-backups:/backups:ro \
  vektor:local node dist/maintenance/cli.js restore /backups/pre-upgrade-2026-11-01
docker run -d --init --name vektor-restored -p 127.0.0.1:8788:8787 \
  -v vektor-restored-data:/data vektor:local
```

Open `http://127.0.0.1:8788`. The persisted access token and instance ID are retained.
An explicitly named fresh Docker volume inherits `/data`'s ownership from the image;
custom bind mounts must be writable by UID/GID `1001:1001` with mode `0700`.

Environment overrides such as `VEKTOR_OPENROUTER_KEY` and `VEKTOR_ACCESS_TOKEN` must be
supplied again; they are not copied into backups. If the source used only an environment
access token and had no token file, restore with that override or use the new generated
token. The web/desktop client needs to connect to the restored URL.

Check health, unlock, inspect a conversation and attachment, and execute a short run.
Scheduler pause and emergency-stop state are preserved: explicitly resume them when
ready. Enabled jobs retain their stored due times and catch-up policy; pause the
scheduler before backup if restored jobs must not run until reviewed.

Restore validates the source, stages verified copies, validates the staged database
and files, then promotes only listed paths. A process interruption during promotion
leaves `.restore-in-progress`; startup refuses that directory. Restore again into
another empty volume rather than manually removing the marker and booting partial data.
An ordinary restore error rolls back files promoted by that invocation. Retain the
backup and original volume until the restored workspace has been checked.

After verification, configure the Compose service to mount the restored volume as
its `vektor-data` external volume, or retain the explicit `docker run` deployment.
Do not delete the original volume as an automatic part of restoration.

## Host development commands

Stop `pnpm dev` or the host API first. Commands resolve relative backup destinations
from the directory where pnpm was invoked:

```sh
pnpm backup /absolute/path/vektor-backups/snapshot-2026-11-01
pnpm backup:verify /absolute/path/vektor-backups/snapshot-2026-11-01
VEKTOR_DATA_DIR=/absolute/path/new-vektor-data pnpm restore /absolute/path/vektor-backups/snapshot-2026-11-01
```

These commands build shared packages and invoke the same maintenance implementation
as the container. The source directory defaults to `.data` for development and `/data`
in production; set `VEKTOR_DATA_DIR` explicitly when using another location.

## Logs and disk retention

The API writes JSON to stdout and, by default, `logs/vektor.jsonl`. Request IDs connect
request/error records. Request bodies, headers and query strings are omitted from
request serializers. Known access tokens, provider keys and encryption-key encodings
are redacted from serialized fields and errors before either output receives them.
Rotated credentials remain redacted for that process's lifetime. Arbitrary unknown
secrets in user-authored content cannot be recognized automatically.

| Variable                    | Default    | Meaning                                |
| --------------------------- | ---------- | -------------------------------------- |
| `VEKTOR_LOG_LEVEL`          | `info`     | Pino level, or `silent`                |
| `VEKTOR_LOG_FILE`           | `1`        | `0` disables only file output          |
| `VEKTOR_LOG_MAX_BYTES`      | `10485760` | Maximum per file, 1024 bytes to 1 GiB  |
| `VEKTOR_LOG_RETAINED_FILES` | `5`        | Current file plus archives, 1–20 total |

Rotation happens before a record would exceed the limit. `.1` is the newest archive.
An individual record larger than the limit becomes a small structured omission record,
preserving valid JSON and the disk bound. Files are `0600` inside the private logs
directory. Compose separately rotates Docker's stdout capture at 10 MB × 3 files.
Log write failures are surfaced rather than silently discarding audit diagnostics.
Use `docker compose logs --tail=100 vektor` or inspect the private log files locally.

## Usage and cost reports

In Settings, choose a UTC date range and provider under **Usage and costs**, then
load the report. The inclusive end date in the UI becomes an exclusive next-day
boundary in the API. Dates group runs by their start time. `GET /api/usage` is
bearer-authenticated and accepts `from`/`to` ISO timestamps plus `provider` equal to
`openrouter` (default), `stub`, `unknown`, or `all`.

Totals and per-profile/per-job tables use persisted provider usage, never context
estimates or current model pricing. Each provider call is counted; repeated cumulative
usage frames replace the current call's usage instead of being added twice. Tool-loop
calls are then summed across the run. Zero-priced calls are distinct from missing
prices. Reports include failed, cancelled and in-progress runs, since these may already
have incurred costs. Received usage is persisted before streaming it to clients.

`knownCostUsd` is the sum of reported costs and is `null` when none were reported.
`pricedCalls`, `providerCalls`, `reportedCalls`, `runsWithoutUsage` and
`incompleteCostRuns` show coverage. A missing final usage frame after cancellation,
failure or a crash remains unreported; known subtotals are not complete bills. A run
with no reported usage never silently becomes a zero-cost run.

The OpenRouter filter excludes demo runs. Provider attribution for pre-Phase-7 runs is
unknown; they remain available in the historical/all views. Historical call coverage
is inferred from aggregate usage and marked incomplete even when a cost was recorded;
exact historical call counts are unavailable. Existing direct scheduled executions
receive job attribution during migration. New retries retain that job ID
but count as distinct charged attempts; older retries cannot be reliably reconstructed.
Archived profiles and deleted job definitions remain attributable by their retained IDs.
These reports reconcile received usage with stored values; consult the provider for an
invoice or unreported charges.

## Upgrade and rollback

1. Record the current Git revision/image ID and data volume. Pause the scheduler if
   restored jobs should require an explicit resume.
2. Stop the backend, create and verify a backup, and keep the old image available.
3. Build the new source (`docker compose build`) or select the intended prebuilt image.
4. Start with `docker compose up -d` and check `/healthz`, startup logs, unlock, a saved
   attachment and a short run. Resume controls explicitly when ready.

Startup applies committed Drizzle migrations before accepting requests. It verifies
the applied migration hashes/order and refuses newer or incompatible history. Migrations
are rerunnable as a no-op after successful application. Do not edit committed migrations,
delete the migration journal, or run an older build against an upgraded volume.

Rollback means using the old image with a verified **pre-upgrade backup restored into
a fresh volume**. It is not a reverse migration. Changes made after that backup are not
in the restored data. Preserve the upgraded volume separately while investigating.
Release packaging and update notifications are documented in [RELEASING.md](RELEASING.md). They never install updates automatically.

On process death, startup marks interrupted runs failed, retains persisted partial
assistant output and received usage, cancels pending tools/approvals, reconciles job
history, and appends one terminal event transactionally. It never automatically retries
external commands. Use the normal retry action after inspecting the failed run; a retry
is a new execution and can repeat previously completed side effects. Final run message,
status, terminal event and audit records also commit together before publication.

Basic terminal access remains a guardrail, not a hardened sandbox. It rejects external
paths, symlinks, hard-linked files, special files, shell/interpreter commands and unsafe
options, strips inherited secrets, caps execution/output, and checks basic paths again
immediately before launch. This does not eliminate all filesystem races with other
processes; use the container boundary and reserve full access for trusted work.

## Repeat the verification

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
docker build -t vektor:phase7-check .
python3 scripts/verify-phase7.py
```

Use `--sudo` for the script when Docker requires passwordless sudo, and `--image` to
select an already built image. The script creates uniquely named disposable containers
and volumes, performs a real offline backup and fresh-volume restore (including a
read-only backup mount), checks credentials/files/jobs/usage, kills a container mid-run,
restarts it and retries the failed run, then removes its own resources. It uses only the
deterministic provider; encrypted synthetic credentials are cleared before any run.
The automated API crash test separately kills the API with streaming, an approved
process group and a pending approval active, then verifies cleanup and recovery.

## Release notifications

Settings → About shows the app/backend versions, last check, and a manual Check now
action. The header shows a release link when a newer stable version is available.
Checks run on the backend, cache success and failure for 24 hours in SQLite, and
use a five-second timeout per attempt with at most one retry. A background check
never delays startup or a run. HTTP 403/429 and 404 do not retry. Redirects are
refused and only the fixed api.github.com release endpoint is queried.

This repository is private, so checks start disabled. Enable them in About and
provide a fine-grained token scoped to this repository with Contents: read. The
token is encrypted in the data directory, write-only through the API, and sent
only as GitHub authorization. It is distinct from the Vektor access token and
provider keys. Public builds omit GitHub authorization entirely. Workspace files,
instance identifiers, usage, and provider credentials are never sent.

`VEKTOR_UPDATE_CHECK=0` disables checks even when forced and locks the About switch.
`1` supplies an initial opt-in; saved preferences can still disable it. Leaving it
unset allows the switch and the compiled repository-visibility default. An optional
`VEKTOR_GITHUB_TOKEN` overrides stored credentials and makes token controls managed
by the backend. The release compose file forwards these variables only when set.
Token-only configuration does not opt a private repository into checks.

## Managed browser

See [BROWSER.md](BROWSER.md) for the pinned engine, profile and scheduled-job grants,
network boundaries, takeover, artifact retention and packaged checks. Browser access
is off by default and independent of terminal access. Screenshots are stored in the
SQLite backup. Separate-session cookies and temporary Chromium profiles are discarded.
The optional default profile saves cookies/site storage encrypted in SQLite, so backups
restore its last saved state as well. Reset in Settings removes current saved state,
not older backup copies.
After a crash, interrupted runs require a deliberate new run/retry and fresh approvals.

## Isolated computer use

See [COMPUTER.md](COMPUTER.md) for Xvfb/Bubblewrap requirements, namespace diagnostics,
application grants, private takeover, screenshot retention and cleanup. Computer
access defaults off independently of browser/terminal access. Each session has its
own authenticated display, sandboxed files/processes and no external network or host
clipboard/file transfer. Scheduled use requires an explicit job grant and retains
input approvals. Emergency stop and API death terminate sessions; restart cancels
pending approvals and never replays input. Host-desktop attachment is not implemented.

## Codex and ACP runners

Native OpenRouter chat remains the default. Codex and ACP are separate execution
backends, not OpenRouter model aliases. Existing profiles migrate to `native`;
legacy `cli` history remains readable while the generic CLI adapter is reserved.
The runner contract is version 1. Codex app-server is pinned to **0.166.0** and ACP
negotiates **protocol 1**. Unsupported versions/capabilities fail closed. Re-check
[Codex app-server](https://learn.chatgpt.com/docs/app-server),
[Codex authentication](https://learn.chatgpt.com/docs/auth), the
[ACP protocol](https://agentclientprotocol.com/protocol/v1/overview) and the
[registry format](https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md)
before changing a supported interface.

### Backend requirements and packaging

External execution requires Linux, usable Bubblewrap user/mount/PID/network
namespaces, Python 3, `prlimit`, CA certificates and writable `/dev/shm`. The Docker
runtime includes the system dependencies; compose allocates 256 MiB of shared
memory. Host/container policy can prohibit namespaces. A failed isolated probe is
an unavailable state, never permission to launch an unsandboxed process. Native
chat does not require these runner dependencies or a Codex installation.

Install the external agent yourself from its publisher. For Docker, add a deliberate
read-only executable bind, such as `/absolute/host/codex:/opt/agents/codex:ro`, in a
local compose override, then probe `/opt/agents/codex` inside Vektor. Do not mount a
host home, Codex configuration directory, provider credential files or Docker socket.
A standalone executable and system runtimes are visible to the probe; adjacent npm
or Python package trees are not shared. Unsupported launcher dependencies remain
unavailable. There is no automatic `npx`/`uvx` installation, package upgrade or remote
ACP transport. ZIP distributions are currently unavailable; supported platform
artifacts are raw executables or tar.gz/tgz, tar.bz2 and tar.xz archives.

### Explicit setup

1. Open Settings → Agent runner setup and **Load setup**. **Find installed
   executables** only checks paths; it does not launch them. For ACP, explicitly
   refresh the official registry and review the entry's publisher/version/source.
2. Choose Codex app-server or ACP v1, enter an absolute installed executable and
   the ACP entry's exact argument array, then **Probe installed agent**. This bounded
   handshake has no credentials, network, host home or workspace. Its hash/version
   record is a diagnostic result, not an execution grant.
3. Choose the probe and registry identity in **Verify and add agent**. Codex requires
   explicit approval of the displayed local executable hash and the supported version.
   Its source is labelled local user trust rather than a registry artifact claim.
   ACP verification downloads the declared official archive through checked public
   addresses, verifies its checksum and compares its executable with the installed
   file. Nothing is extracted into a host path or executed from registry metadata.
   Missing checksums, mismatched versions/hashes or unsupported packaging cannot enable
   an entry. Codex's ACP alias is blocked while its app-server adapter is used.
4. Review the exact inference hosts and credential variable. Codex accepts
   `api.openai.com` and a separate `OPENAI_API_KEY`; ACP accepts the supported key
   variable selected for that agent. Save the key in the password field, then enable
   the agent explicitly. A configured key does not prove entitlement: an inference
   turn verifies that model/account access. OpenRouter keys are never reused. Agent
   accounts, model availability, subscription limits and billing are separate.
5. Under **Profile grants**, select the specific agent and separately grant real
   workspace access and its configured inference hosts. Changing the grant's agent
   clears both capabilities. In the profile editor, select the runner/model and
   **Full access**, enable terminal, and keep browser/computer access off. ACP's
   `agent-default` uses its advertised/default model; an explicit model id requires
   an advertised ACP model configuration option. Codex uses the requested API model.

OpenCode uses the existing ACP adapter with runner identity `acp:opencode`. The
**Set up OpenCode** preset selects ACP v1, `["acp"]` arguments, the OpenCode registry
entry, `OPENROUTER_API_KEY`, and `openrouter.ai`. Discovery includes `opencode` even
before a registry refresh. Refresh the registry and install its matching Linux
binary before probing and verifying; the same archive checksum, executable hash,
and version checks apply as for other ACP agents. The preset does not launch or
enable an agent. Host OpenCode logins/configuration are not imported.

For another provider, change the inference hosts and credential variable before
verification (for example, `OPENCODE_API_KEY` with `opencode.ai` for OpenCode Zen).
Use an advertised provider/model ID matching that provider. `agent-default` follows
OpenCode's default selection and does not guarantee use of the preset provider.
Inference hosts must include all public destinations required by that provider.
To check a locally installed OpenCode handshake without credentials or inference:
`VEKTOR_OPENCODE_PROBE_BIN=/absolute/path/opencode pnpm --filter @vektor/api exec vitest run src/runners/probe.test.ts`.

Verification/add, key save, enablement, profile grants and launch are distinct actions.
An upgrade repeats the probe/verification flow and leaves the entry disabled until
explicitly enabled again. Changing inference destinations or credential type clears
the old key. Removing an agent stops its sessions and clears its credential/grants;
shared managed binaries are removed only after their final installation reference.
Registry changes invalidate stale provenance rather than trusting an old enabled flag.

### Filesystem, tools and network boundaries

A run receives a clean environment, private home, isolated `/tmp`, a text workspace
snapshot and its own intended agent credential. Backend data, attachments, host homes,
saved browser sessions, displays, integration credentials and Vektor's access token
are not mounted. Workspace snapshots omit `.git`, `node_modules`, `.env` and `.env.*`
files, `.npmrc`, `.netrc`, oversized/non-text files and text containing known backend secrets.
Only explicitly selected attachment text and conversation context are supplied in the
prompt; excluded attachments and image input are not forwarded by these adapters.

Codex's effective shell, unified execution, apps, plugins, browser, computer and MCP
controls are verified before a turn. Its real workspace tools are Vektor's dynamic
terminal/read/write broker. ACP may use client filesystem/terminal calls or its own
local tools. Local tools operate on an isolated snapshot, not the real workspace.
After the agent exits, Vektor collects local file proposals, shows their previous/new
content and requires approval for each write or deletion. Conflicting human edits,
links, special files and paths outside the workspace prevent application. Brokered
file writes and host terminal commands likewise require fresh Vektor approval.
A harness permission request only concerns the isolated operation shown; it cannot
authorize a later real workspace action or widen any grant. Unknown permission kinds
are denied, and `allow_always` is never selected.

**Approved terminal commands retain existing Full-access semantics:** they run with
the backend account's permissions, can use paths outside the workspace, and require
approval before execution. The isolated agent's own processes have no such host
access. Browser/computer, Basic, No-terminal and Full Unrestricted mappings are
currently rejected for external runners. Use an explicit Native selection for those
existing capabilities. No Vektor MCP or integration configuration is inherited.

The agent network namespace has no host route. A private bridge accepts HTTPS CONNECT
only for its exact configured inference hosts on port 443. Public DNS is checked and
pinned; private, loopback, metadata, reserved addresses and other destinations are
blocked, including redirect destinations that require another tunnel. There is no
inference grant implied by a profile's browser permission. Approved host terminal
commands remain the separate Full-access action described above.

There are at most four external sessions. Processes have a 4 GiB per-process address
space limit, 120 seconds of CPU, 128 file descriptors and a 32 MiB per-file limit.
Protocol output, headers, connections and tool counts are bounded. Snapshots contain
at most 1,000 text files/32 MiB; proposals and broker calls have a 32-action budget.
The run deadline, session deadline and shared-memory capacity can end work sooner.
These resource guards share the backend's host/container resources; this is not a VM
or protection against kernel vulnerabilities or resource exhaustion by arbitrary code.

### History, resume, cancellation and recovery

Run rows persist the runner, interface/version/hash, session/turn ids, lifecycle cursor,
state and available metrics. Timeline/audit records distinguish harness-local actions,
real broker calls, staged file proposals and approval decisions. Vektor estimates the
selected text budget; the harness owns its internal context and compaction. Available
Codex token counters are reported without fabricated cost. Resume subtracts the saved
thread baseline; unavailable ACP metrics stay unavailable rather than zero-priced.

The composer can override a runner for one queued message without changing its profile.
Retries retain the original runner. **Resume saved agent session with this new message**
restores a completed compatible checkpoint only after explicit selection. It sends the
new message, not the interrupted/original prompt. Version, policy, authentication,
profile, conversation, attachment or history-scope changes can reject resume. Start
fresh after excluding context, changing credentials, upgrading, truncating history,
or when the checkpoint has expired or been deleted.

Private homes are checkpointed only after the process exits and encrypted with the
backend secret key. At most twenty completed checkpoints are retained, each capped at
32 MiB before encryption. Delete a saved checkpoint in run history to remove its resume
state; this does not delete the recorded conversation/audit history or older backups.
The offline backup/restore workflow includes managed runner binaries and encrypted
checkpoints; managed binary paths are remapped to the restored data directory and
hashes are checked before a later launch.

Stop sends turn/session interruption when possible, then terminates supervised process
groups. Pending approvals and commands are cancelled. Emergency stop also retains the
global latch, and profile/agent/grant/key revocation cancels affected active work.
An API-parent watchdog kills descendants and removes private runtime directories after
API death. Restart marks interrupted runs/approvals failed/cancelled, preserves their
partial output and never reconnects or replays prompts automatically.

Scheduled external jobs use the same admission gate, durable history, command/file
approvals and stop latch. They pause for human approval rather than assuming unattended
access. An unavailable agent never falls back to native or another runner. Failed
connections get a persisted exponential reconnect delay (2–60 seconds); another attempt
still requires an explicit action. Key/configuration changes reset diagnostics, while
successful turns record healthy access. Native chat remains available throughout.

### Verification

`pnpm test`, `pnpm lint`, `pnpm typecheck` and `pnpm build` cover the shared contracts,
migrations, registry parsing/cache, artifact verification, credential isolation, actual
Bubblewrap execution, native/ACP broker flows, staging conflicts, approvals/denials,
scheduled pauses, revocation, explicit resume and API SIGKILL/restart cleanup.

Opt-in protocol checks use an already installed Codex binary and the live official
registry, with no paid inference or real provider key:

```sh
VEKTOR_CODEX_PROBE_BIN=/absolute/path/to/codex VEKTOR_LIVE_REGISTRY=1 \
  pnpm --filter @vektor/api exec vitest run src/runners
```

The real-Codex test uses a temporary local TLS model fixture to exercise the installed
harness, tool broker, approval, encrypted checkpoint and resume without incurring model
charges. ACP conformance fixtures exercise the complete official-artifact verification,
enablement and execution path. Account-specific model entitlement and provider quota
are checked only when the user supplies that agent's key and starts a real task.

## MCP plugins

Optional local stdio and remote Streamable HTTP servers are managed in Settings → MCP
plugins. Configuration, protected credentials, testing, enablement and per-profile
capability grants are explicit steps. MCP tool calls always require approval, and local
file proposals receive separate review. Jobs additionally declare permitted servers;
Codex/ACP require a separate external-runner grant. Prepared resources/prompts are
included only when selected for a message.

See [MCP operations](MCP.md) for the pinned protocol/SDK, packaging, isolation and network
boundaries, schema/resource limits, context selection, artifact retention, backup,
cancellation, crash recovery and verification commands.
