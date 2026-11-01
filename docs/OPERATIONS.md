# Vektor operations

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
