# MCP plugins

Vektor supports explicitly configured MCP servers for tools, text resources,
resource templates and prompts. Native, scheduled, Codex and ACP runs share grants,
approvals, stop controls and audit history. Plugins are optional and off by default.

The pinned protocol is **2025-11-25**, using official TypeScript SDK **1.32.2**.
Transports are local stdio and remote Streamable HTTP with JSON/SSE responses.
Other revisions, legacy HTTP+SSE, background tasks, sampling, elicitation, client
filesystem roots and subscriptions are unavailable. There is no automatic installation,
OAuth browser flow or marketplace; remote authentication uses protected headers.

## Setup and permissions

1. Open **Settings → MCP plugins → Load MCP settings**. This reads cached metadata;
   it never starts a process or contacts a server.
2. Add an installed local executable or exact remote endpoint. Local launch requires
   its explicit checkbox. Arguments are an array with no implicit shell. Saving
   configuration leaves the server disabled.
3. Add separate credentials under **Protected environment variables/headers**.
   Values are encrypted and write-only; only their names are returned. Protected values
   need at least eight characters. Ordinary local flags use the non-secret environment
   object. Reserved home/path/proxy/runtime-injection/Vektor variables are rejected.
4. Click **Test / reconnect** to deliberately launch/connect, negotiate the pinned
   protocol and discover capabilities. Local tests get an empty workspace, private home
   and only configured credentials/network hosts. Review the server/version and warnings.
5. Enable the tested server, select a profile, select individual tools/context sources
   and save its grants. Codex/ACP and scheduled use have separate opt-ins.

**Every MCP tool call requires fresh Vektor approval**, including read-only hints and
Full Unrestricted profiles. The approval identifies server, tool, policy and arguments.
Denial prevents `tools/call`. MCP grants are independent of terminal/browser/computer
permissions: a No-terminal native profile can use a granted isolated MCP tool without
gaining host commands. Server metadata cannot approve calls or widen permissions.

Editing command, arguments, environment, endpoint or destinations disables the server,
clears its protected values and invalidates grants. Replacing credentials also requires
a fresh test/grants. Executable, version or definition drift blocks execution. Testing
a changed executable/definition disables it and requires renewed grants. Disable/remove
and grant revocation cancel affected work/approvals. Removal clears credentials, grants
and prepared context. Native conversations without that server remain usable.

## Local and Docker packaging

Local execution needs Linux, usable Bubblewrap user/mount/PID/network namespaces,
Python 3, `prlimit`, CA certificates and writable `/dev/shm`. Docker includes these
dependencies; compose allocates 256 MiB shared memory. Host/container policies can
deny namespaces. Isolation failure leaves the server unavailable and never triggers
an unsandboxed launch.

Install a standalone executable or executable script yourself. Its interpreter and
dependencies must exist in the visible system runtime directories. Adjacent package
trees and host homes are not shared. Vektor does not install `npx`/`uvx` packages.
For Docker, deliberately bind only the executable read-only in a local override:

```yaml
services:
  vektor:
    volumes:
      - /absolute/host/my-mcp-server:/opt/agents/my-mcp-server:ro
```

Backend uid 1001 must be able to read/execute the file. Configure its container path.
Do not mount a home, credentials, Docker socket or real desktop. Unsupported interpreter
or dependency layouts fail the explicit test. Host and container use the same setup API.

The working directory is relative to Vektor's workspace. A tool or explicit context
preview gets a text snapshot of only that directory as `/workspace`, never the real
workspace. Traversal, links and invalid parents are rejected. Snapshots omit `.git`,
`node_modules`, `.env`, `.env.*`, `.npmrc`, `.netrc`, oversized/non-text files and text
containing known backend secrets. Limits are 1,000 files/32 MiB and 256 KiB per file.
Attachments, backend data, host homes, browser sessions, displays and inherited
Vektor/provider credentials are not mounted.

**Read-only** tools need the server's read-only hint and receive a read-only local
snapshot; approval is still mandatory. **Approval** tools may write isolated scratch.
After process exit, Vektor collects up to sixteen proposals and requires separate
approval for each real write/deletion, showing its directory and before/after content.
Baseline hashes reject concurrent human edits. Links, special files and credential-bearing
proposals are refused. Local tool output cannot authorize its own host effects.

Only configured environment values reach the process. Protected values are loaded from
a private temporary file, never argv. Stderr is bounded and never logged/returned.
The network namespace has no host route; a private HTTPS CONNECT bridge permits only
the configured exact public hosts on port 443. Empty hosts blocks external networking.
DNS is checked/pinned; private, loopback, metadata and reserved destinations are blocked.
Configured keys/destinations are capabilities of that third-party process, including
during an explicit test. Isolation shares the host kernel/resources; it is not a VM.

Connections are operation-scoped. Private homes/process state are discarded after each
test, preview or tool call, and HTTP sessions are terminated when supported. Servers
should keep durable state in approved workspace files or their remote service;
in-memory handles are not carried between operations or resumed after restart.

## Remote connections

Use an exact HTTPS MCP endpoint with its own `Authorization` or `X-*` headers.
Credentials in URLs, query strings/fragments, redirects, cookies, proxy headers and
endpoint changes are rejected. TLS uses the backend's trusted CA store. Browser cookies,
OpenRouter keys and Codex credentials are not inherited.

Local HTTP needs the explicit loopback checkbox and a loopback endpoint. Every resolved
address must be loopback in that mode; Vektor's backend listener remains blocked.
Other private, loopback, metadata and reserved targets are blocked using Phase 9's
network policy. Browser allowlists cannot grant MCP access. Remote implementations
control their effects, so read-only hints never bypass approval.

Session/version headers and streamed progress are supported. Cancellation and deadline
expiry send MCP cancellation notifications. Disconnected calls/SSE streams are never
automatically replayed or resumed. A remote service may ignore cancellation or have
already completed an approved effect; cancellation does not imply rollback.

## Selected context and results

Grant particular resources/templates/prompts, save grants, then use **Prepare preview**.
Prompt/template arguments are explicit strings. Only text content is accepted. Preparing
a preview contacts that selected source; discovery and server instructions never become
system instructions or implicit context.

Open **MCP context** in the composer, load prepared items, inspect and select them for
the message. Selection is per message and retained in the queue/history. Limits are five
items, 32 KiB each and 100 KiB total. Token estimates include selected content. Unselected
sources/attachments are not forwarded. Profile/server revision and grants are rechecked;
revocation during context reading/message preparation prevents the message from starting.
Retries retain the original selection. Changing/excluding MCP context or changing MCP
configuration/grants rejects external-session resume and requires a fresh session.

Tools, descriptions, resources, prompts and results are untrusted data. They cannot
grant access, approve actions, call other Vektor tools or read another server's secrets.
Namespaced model tool ids use the full server id plus a tool-name hash. History shows
readable server/tool names, progress, arguments/results, approvals, file applications,
duration and errors separately from native/browser activity.

Input and structured-output schemas are validated off the API thread with bounded
memory/time. Remote schema references are never fetched. Format annotations are not
extra semantic validators. Uncompilable schemas and task-required tools fail discovery.
Each profile may grant at most 64 MCP tools.

Results are capped at 128 KiB. Large accepted results use a bounded model preview and
an encrypted full-result artifact. History provides **View full MCP result** and
**Delete MCP artifact**. Prepared context can be previewed/deleted in the composer.
Both encrypted collections keep at most 100 items for seven days; expired files are
rejected and pruned on subsequent writes. Deletion leaves recorded chat/audit text and
older backups intact. Offline backup/restore includes MCP encrypted files and database
configuration/credentials.

## Scheduling, external runners and recovery

A job needs both a scheduled profile grant and an explicit choice under **Declared MCP
servers**. An empty declaration exposes no MCP tools. Jobs wait for human approvals.
Changing a job's MCP declaration/profile or disabling it cancels active MCP work and
updates durable job history.

Codex gets only separately granted MCP tools through Vektor dynamic tools; its own MCP
configuration stays disabled. ACP gets one run-scoped stdio broker inside its namespace,
exposing only granted tools through the same approval path. Actual server endpoints,
commands and credentials are not passed to the agent. ACP loading cannot replay broker
calls before an active prompt.

At most four MCP connections are active. Initialization/discovery requests have ten-second
deadlines, tools a fixed thirty-second deadline, and operations a sixty-second lifetime,
also bounded by the run deadline. Progress never extends a tool deadline. Frames,
protocol output, queues, HTTP requests and connection counts are bounded. Each discovered
category has at most 100 entries over five pages. Schemas are limited to 32 KiB each and
128 KiB total, with a two-second worker deadline and 64 MiB old-generation limit. Local
process limits match [external runner operations](OPERATIONS.md#codex-and-acp-runners).

Failures produce a persisted exponential 2–60-second reconnect delay. Another attempt
requires an explicit action; **Test / reconnect** discovers capabilities and never retries
a failed tool. The native loop receives a tool error and can continue using native tools.
There is no silent runner switch or automatic resubmission.

Stop/emergency stop cancels requests, approvals and supervised processes. Emergency stop
retains its latch. An independent API-parent watchdog kills local descendants and removes
private runtime directories after API death. Restart marks interrupted history failed/
cancelled and never reconnects or replays MCP work.

## Verification and references

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm format:check
pnpm build
pnpm release:pack
pnpm release:verify
```

Tests run real isolated stdio executables and HTTP/SSE fixtures through the authenticated
API. They cover approval/denial, Codex/ACP bridges, scheduled declarations, context
isolation/revocation, schema/time/size bounds, read-only enforcement, file conflicts,
secret redaction, disconnects, explicit reconnect and actual API SIGKILL/restart cleanup.
React tests cover settings and context selection. No real service keys or paid inference
are used.

Verification on 2026-11-02 passed the complete workspace suite, lint/typecheck/format,
production build, release verification and this smoke flow against the extracted API
release. The installed Codex 0.166.0 harness also completed an MCP call with Vektor
approval and explicit durable resume against a TLS model fixture. Docker HTTP/SSE
checks passed; local namespace creation was denied under this host's default container
policy, and its local-server probe correctly stayed unavailable.

The container smoke check is included in CI and release verification workflows:

```sh
docker run --rm -i --shm-size=256m --entrypoint node \
  -e VEKTOR_API_ROOT=/app vektor:phase12-check --input-type=module < scripts/mcp-smoke.mjs
```

Protocol references: official
[lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools),
[resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources),
[prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts),
[cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation),
[TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and
[ACP MCP session setup](https://agentclientprotocol.com/protocol/v1/session-setup).
Re-check these contracts and fixtures before upgrading the pinned protocol/SDK.
