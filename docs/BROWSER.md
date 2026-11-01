# Managed browser operations and design

Phase 9 uses Playwright **1.64.1**, pinned exactly in the API dependency and lockfile,
with its bundled Chromium **156.0.8078.4**, revision **1248**. The controller interface
is separate from the provider and terminal executor. This selection follows the
user's instruction to start Phase 9; Phase 8's first live publication remains pending.

## Enable a profile

Browser access defaults off for existing and new profiles. In Settings, choose
Observation only or Interactive, then choose a browser profile:

| Access      | Default profile                                            | Separate session                                        |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Observation | Reuses saved site logins with read/navigation tools.       | Starts clean with read/navigation tools.                |
| Interactive | Reuses saved site logins; actions still require approvals. | Starts fully separate; actions still require approvals. |

Existing profiles retain separate sessions. Newly enabling observation in Settings
selects Default initially; newly enabling interactive access selects Separate. You
can explicitly choose either session type for either access mode. The default
profile belongs to Vektor; personal Chrome/Chromium profiles remain separate.

Enter exact HTTP(S) origins, including any
required subresource/CDN origins. Wildcards, credentials, paths and non-HTTP schemes
are refused. Terminal access does not grant browser access, and no-terminal profiles
can independently use an enabled browser. Changing or archiving a profile closes
its active browser sessions and cancels pending browser approvals.

Local app testing requires a separate explicit grant, such as
`http://127.0.0.1:3000`, with a local-testing acknowledgement in Settings. Only exact
loopback host/port combinations are supported; this does not grant private LAN or
cloud metadata access. Loopback means the backend container when using Docker.
The backend's own listener port is blocked even with a local grant. No Chrome
debugging port or connection to the user's personal browser is offered.

Install the engine on a host backend after installing dependencies:

```sh
pnpm browser:install
```

On a clean Linux system, the official installer can also install OS dependencies:

```sh
pnpm --filter @vektor/api exec playwright install --with-deps chromium
```

The Docker image includes the pinned engine and OS dependencies. The API archive
contains Playwright but needs the host browser install separately; from its extracted
directory, use `node api/node_modules/playwright/cli.js install --with-deps chromium`.
The desktop uses its connected backend's managed browser and requires no browser
automation permissions for the user's personal desktop.

## Visible windows and UI controls

Settings → Profile → Browser window now chooses **Headless** or **Visible window**,
independently of observation/interactive access and default/separate profile choice.
Existing profiles stay headless. The choice applies to a new run. The agent opens
Chromium lazily on its first browser tool request; the run timeline also offers
Open browser window before that first request and Focus browser window afterward.
The panel shows launch state, the selected session/display mode and display errors.

A visible window opens on the **backend machine's desktop**. A local backend should
be started from the user's desktop session so it inherits its display connection.
Linux forwards only the X11/Wayland connection variables and, when present, the X11
authority-file path. Backend/provider credentials are still excluded from Chromium's
environment. The desktop app remains a client of that backend; its connection to a
Docker backend does not make the browser appear on the client's own desktop.

The stock Docker configuration has no desktop display, so Headless remains its normal
mode. A visible Docker browser requires an explicitly connected display or remote
desktop outside this feature. Vektor reports this in Settings and disables the run
launch button when the backend reports no display. A failed headed launch never
silently falls back to headless. This implementation's headed validation runs on
Linux with an isolated Xvfb display; native macOS/Windows desktop behavior is not
manually verified.

Pause and take over in the run panel before manually interacting with the window.
Visible takeover makes the session private: page text/screenshots are withheld and
automation remains blocked until it is closed. A Chromium isolated-world event guard
also detects trusted input in the managed page, pauses the agent and cancels pending
approvals. Page JavaScript cannot invoke that isolated binding; typed characters
are never included in its messages. Use the explicit pause control before entering
secrets, especially in embedded frames or while an automated action is in flight.
Network requests in visible interactive windows proceed automatically, including
background page requests. Observation still blocks writes. Origin, address,
credential and size checks continue to apply.

The window closes with its run, cancellation, disconnect or emergency stop. Closing
it directly does not cause the agent to reopen it automatically; start a new run.
Visible default-profile sessions checkpoint changed cookies/site storage on page load
and every two seconds while open. Closing the native window retains the most recent
completed checkpoint; use Disconnect in Vektor for a final save of the latest state.
Separate windows never save into the default profile.

## Session and network boundaries

Each run launches a fresh Chromium process in a private temporary directory. With
**Separate session**, no saved browser state is loaded or written, and closing the
session deletes its cookies/storage and temporary profile. Separate sessions are
independent of the default profile and of other runs.

With **Default profile**, authorized cookies, local storage and IndexedDB are loaded
from Vektor's saved profile, then saved back when the session disconnects or closes. Visible windows also checkpoint
changed state while open.
The state is encrypted with the existing secrets key in SQLite, limited to 4 MiB,
and included in normal data backups. Loading and saving use only origins/domains
allowed by the current agent profile; state for other origins is preserved without
being loaded. This retains site logins/preferences, not personal browser tabs,
history, extensions, password-manager entries or sessionStorage. A failed/oversized
save keeps the previous snapshot and reports an error in profile status. Corrupt
saved state requires an explicit reset rather than silently starting an empty profile.

Only one run may use Default at a time, including while its final snapshot is being
saved. A second run must wait or use Separate. Two total sessions remain the limit,
so one default and one separate session can run alongside each other.

Settings → Default browser profile provides status, Disconnect and Reset. Disconnect
closes the current default session and keeps saved logins; Reset also deletes saved
state and prevents the closing session from restoring it. Both invalidate pending
browser approvals and prevent that run from automatically reconnecting. Separate
sessions are unaffected. Reset does not erase backups or revoke remote server sessions.

Only PATH, the temporary HOME/TMPDIR and a fixed locale reach the browser process;
backend, provider and GitHub credentials are not inherited. Temporary Chromium
profiles are still removed on close and after a crashed backend restarts. A crash
keeps only the default profile's previously completed saved snapshot, not any new
unsaved state or interrupted browser actions.

Chromium's ordinary HTTP networking points at a nonfunctional proxy with loopback
bypass disabled. Service workers, WebSockets, QUIC and non-proxied WebRTC UDP are
blocked. The controller intercepts HTTP(S) requests and fulfills them through a
backend transport. It validates the exact target origin and every resolved address,
then pins the TCP connection to one validated address while retaining the original
HTTP Host and TLS hostname verification. Mixed public/private DNS results are
rejected. Loopback, private, link-local, metadata, carrier-grade NAT, multicast,
reserved and IPv6 transition ranges are blocked unless the exact loopback testing
exception applies. Redirects and iframe/subresource requests pass the same checks;
the transport itself never follows redirects. Backend credentials in URLs, headers
or request bodies cause refusal. There is no page JavaScript/evaluate tool, arbitrary
selector tool, HTTP-client tool or connection to a personal profile.

These are application network/file guardrails, not a claim of protection against a
Chromium native-code exploit. Chromium runs with the backend account and its renderer
OS sandbox disabled for container portability. Use a dedicated, constrained Docker
backend and narrowly trusted origins; full terminal access retains its existing
ability to bypass application guardrails. This phase does not implement a separate
browser VM/container or host firewall that could contain a compromised browser.

## Observation, approvals and takeover

Observation exposes navigation, tabs, accessibility/DOM snapshots, screenshots,
scrolling and bounded waits. It exposes no click, typing or file-transfer controls.
Non-GET/HEAD network requests are also refused. Navigation and page scripts still
make GET requests, which can have external effects; observation is not a guarantee
that the remote service has no side effects.

Interactive profiles add filling, clicking and scoped file transfers. Every click
requires an approval bound to the page URL, navigation generation, connected element,
element/form markup and current form field values. The prompt includes an untrusted
target label and a SHA-256 fingerprint, not private field values. A subsequent
non-GET/HEAD request in a headless session requires a separate approval bound to method, URL, payload hash,
source page and session generation. Denial prevents the action/request. Approval is
single-use, expires after 30 seconds, and is invalidated by pause, page/target change,
permission change, shutdown or emergency stop. Headless background tabs cannot make writes.
Visible interactive windows allow network writes without request approvals.
Scheduled jobs have a separate browser declaration, default off, that can only reduce
the profile's capability. Interactive scheduled jobs wait for the same human approvals.
They never infer unattended consent from the schedule or page content.

The run timeline includes browser tool results, origin, snapshots, approval records
and retained screenshots. Page content and downloads are explicitly untrusted data;
they cannot change permissions, invoke arbitrary backend APIs or approve themselves.
Model tool arguments and outputs pass the existing secret redactor. Fill values are
withheld from persisted tool inputs, and human takeover logs only the action kind.

Open Managed browser in the run timeline to pause and take over using the page's
element references. The agent waits while paused; reference changes require a new
snapshot. The original run deadline continues to apply. Already dispatched actions
cannot be undone, while later requests/actions are blocked or require fresh approval.
User clicks during takeover are explicit actions; headless network writes still prompt.
Model access to password/payment/one-time-code/secret fields is refused. Takeover
typing is private by default, with an explicit Private input toggle for public text.
Private input suppresses subsequent DOM previews and screenshots, hides URL paths
and queries, and keeps the session under human control until it is closed. It is not
returned to the model. Do not resume automation in a private session; close it first.

## Files, artifacts and limits

Uploads accept only a selected attachment ID belonging to the run's channel. The
backend refuses symlinks, hard links, special files, changed sizes and files over
2 MiB. Only file bytes and a safe filename reach Chromium, never a backend pathname.
Approval binds the selected file's hash, name and size. Arbitrary host/workspace
paths are not accepted; attach a workspace document through the normal upload UI first.

Downloads use an explicit approved, direct HTTP(S) URL, the same network rules and
a 2 MiB limit. HTML, scripts and executables are refused; normal document/image
extraction and channel quotas also apply. Downloads become excluded channel
attachments with previews. They are not silently added to model context or executed.
Automatic browser downloads are cancelled. Automatic page uploads/network writes
in headless sessions cannot bypass the request approval gate.

Screenshots mask all form fields and editable regions. Private sessions produce no
new screenshots. Authenticated artifact routes serve JPEG bytes with no-store and
nosniff; image bytes never appear in metadata or external links. Screenshots live in
SQLite, so existing database backups include them. Metadata has an expiry of seven
days by default, configured by `VEKTOR_BROWSER_ARTIFACT_DAYS` (1–30). Expired bytes are
pruned when artifacts are listed/read/saved; storage is capped at 32 MiB of JPEG data
with a 1 MiB per-image limit. Delete retained screenshots in the run timeline to purge
a run's images immediately. Backups and ordinary tool/snapshot history have their
existing independent retention; SQLite file space is reused rather than immediately
shrinking after deletion.

At most two sessions, four tabs per session, 50 actions and 200 HTTP requests per
session are allowed. Transfers/responses are capped at 2 MiB; browser actions have
five-second timeouts, navigation 20 seconds, HTTP requests 15 seconds, startup 15 seconds and waits at most
two seconds. Navigation timeouts leave the window open for inspection; failed navigation
error pages remain open so a later explicit navigation can recover. The existing run deadline, tool-loop/context/output budgets and global
stop controls still apply. Cancellation closes Chromium and aborts pending HTTP
requests; shutdown waits for session cleanup. Chromium's debugging pipe closes when
the API dies, ending its process. Restart marks interrupted runs failed, cancels
their approvals, deletes only this backend's abandoned temporary profiles and does
not replay browser actions. Separate-session cookies are discarded; a default session
may explicitly load its last completed encrypted snapshot on a new run.

## Verification

The normal tests include real local Chromium fixtures for form inspection/fill,
click and payload approvals, denial, stale form targets, off/observation permissions,
subresources, iframes, redirects, sockets, hostname pinning, private/reserved addresses,
cookies/tabs, private takeover, file boundaries, artifact expiry, scheduled declarations
and stop/revocation cleanup. An API subprocess is actually killed with SIGKILL while
a browser approval is pending; the test checks Chromium exit, failed-run recovery,
cancelled approval, discarded profile/cookies and absence of replay after restart.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node scripts/browser-smoke.mjs
docker build -t vektor:phase9-check .
docker run --rm -i --entrypoint node -e VEKTOR_API_ROOT=/app \
  vektor:phase9-check --input-type=module < scripts/browser-smoke.mjs
python3 scripts/verify-phase7.py --image vektor:phase9-check
```

The packaged smoke uses a deterministic provider and local fixture inside the image,
with no live provider bill or external site mutation. CI and release verification run
it before publication. Native desktop packaging remains covered by the existing job.
Manual interaction with arbitrary external sites is not claimed by these fixtures.

Primary implementation references: [Playwright network interception](https://playwright.dev/docs/network),
[browser contexts](https://playwright.dev/docs/api/class-browsercontext),
[page APIs](https://playwright.dev/docs/api/class-page), and
[Playwright releases](https://github.com/microsoft/playwright/releases).

Saved-profile verification additionally covers encrypted backup/restore, authorized-origin
filtering, default-profile reuse in observation mode, separate-session cookie/storage
isolation, profile ownership through asynchronous close, reset without stale state
revival, authenticated management endpoints and Settings profile selection. Storage
reuse follows the [Playwright authentication state APIs](https://playwright.dev/docs/auth).

Visible-window verification covers real window creation/focus on Xvfb, private native
takeover, automatic-action compatibility, saved-profile checkpoints, native closure
without relaunch, authenticated UI launch/focus, disabled permissions and no-display
diagnostics. The guard uses Chromium's [isolated-world initialization](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument)
and [runtime bindings](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-addBinding).
