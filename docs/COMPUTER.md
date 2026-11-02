# Isolated computer operations and design

Phase 10 implements a Linux backend virtual desktop. It never attaches to the user's
real desktop. Host attachment remains a separate opt-in milestone requiring a local
bridge, OS permissions, a connected-session indicator and a revocable grant.

## Requirements and capability checks

Install `xvfb`, `xdotool`, `ffmpeg`, `bubblewrap`, and `util-linux` on the backend.
`x11-utils` supplies the deterministic `xmessage` test application:

```sh
sudo apt-get install -y xvfb xdotool ffmpeg bubblewrap util-linux x11-utils
```

The Docker runtime image includes these packages. Linux must permit Bubblewrap's
user, mount, PID and network namespaces. Container security profiles or host policy
may prohibit them. The capabilities endpoint runs a bounded namespace probe and
reports an unavailable reason in the run panel; it never falls back to an unsandboxed
application. Native chat and browser/terminal permissions remain independent.

## Isolation and grants

Each run has a private Xvfb display, X11 cookie and temporary session directory.
Applications launch through Bubblewrap with separate user, mount, PID, IPC and
network namespaces, a clean environment, no capabilities, and no inherited provider
keys. Only system executables, libraries, shared assets/fonts, the session's X11
socket and its authentication cookie are exposed. Applications must be installed in
`/usr/bin` (including `/bin` aliases). Backend data, attachments, the host home,
workspace, other displays and D-Bus sockets are not mounted. Applications have a
private temporary home and `/tmp`; switching applications starts a fresh filesystem.

External networking, clipboard bridging and file transfer are disabled. There is no
API or profile grant that enables these in Phase 10. Future transfer/network support
must introduce separate scoped grants and approved attachment paths. Applications
can still use their own virtual-desktop clipboard, which is never connected to the
host clipboard.

Application address space is limited to 2 GiB, CPU time to 120 seconds, regular files
to 32 MiB and open files to 128. The temporary home and `/tmp` each have a 64 MiB
limit. At most two desktop sessions can be active. Linux kernel isolation is the
boundary; this is not a VM or protection against kernel vulnerabilities.

## Configure a profile

Computer access defaults to **Off** for existing and new profiles, independently of
browser and terminal access. In Settings → Profile → Computer access:

| Mode        | Allowed actions                                     |
| ----------- | --------------------------------------------------- |
| Off         | None                                                |
| Observation | Screenshot, windows, bounded wait, private takeover |
| Control     | Observation plus launch/focus, pointer and keyboard |

Configure the virtual screen size and up to five explicitly allowed applications.
Commands are absolute paths with argument arrays, never shell interpolation. For a
benign fixture, use `/usr/bin/xmessage` with arguments `-default`, `okay` and
`Phase 10 test` (one per line). Focusing this window and pressing Return closes it.
The first application starts on demand; `launch` switches to another granted app.
Window focus must target a currently visible window in that private session.

Choose an action limit (1–200, default 60), time limit (up to 30 minutes, default
5 minutes), and screenshot retention (0–30 days, default 7). Observation requests
count toward the action limit; live user preview polling does not. The run's overall
execution deadline can end the desktop sooner. Exhausted budgets close the session;
a new run is required. A model known not to support image input or tool calls is rejected before
computer execution.

## Approval and stale input

Every automated mutating action requires its own human approval, including pointer
movement, app switching and focus. This conservative rule covers consequential
submits, deletion, installation and account/security changes without guessing which
pixels are safe. Approval expires after 30 seconds. Denial, timeout, cancellation,
profile changes, changed foreground/windows, changed geometry or manual takeover
invalidate the action. The target is checked again after capturing the before image;
drag steps also recheck it. Coordinates use absolute virtual-screen pixels, independent
of the preview's CSS scale. Only one screen is supported; changed geometry closes the
session rather than applying stale coordinates to another screen.

Screenshots, application output and window titles are untrusted data. They cannot
grant permissions or approve actions. A screenshot requested by the agent is sent as
an explicitly untrusted image after all responses to that batch of tool calls.

## Private takeover

Choose **Private takeover** before login, password, payment or other sensitive input.
The agent can request the same transition with `takeover`. Manual text and keyboard
controls enter private takeover automatically. Private mode pauses the run, cancels
pending approvals, blocks all agent input and screenshots, suppresses window titles
from model-visible state, and disables screenshot artifacts. The authenticated user
can still see the live preview and use manual controls.

**Private mode cannot be resumed. Close desktop when finished.** Closing destroys
the application and its temporary filesystem, then allows the agent to continue
without the private screen. This avoids exposing secrets in a later screenshot.
There is no claim of automatic sensitive-field recognition for arbitrary desktop
applications: use takeover before interacting with sensitive content.

Manual values are omitted from audit records, cleared from the UI after submission,
and supplied to xdotool through stdin rather than process arguments. Manual controls
are audited by action kind. Backend credentials are refused as tool input.

## History and retention

Automated mutating actions save paired before/after JPEGs with an action id, kind,
timestamp and expiry. The run panel lists them alongside the tool timeline; images
load only on request through authenticated, `no-store` endpoints. Metadata contains
no image bytes. Private and manual actions never create artifacts.

Each image is capped at 4 MiB and total computer screenshot storage at 32 MiB.
Expired records are pruned on startup and artifact access/save. If the before image
cannot be retained, new input is blocked until screenshots are deleted or retention
is disabled. If storage fills after input, the result explicitly reports that the
action occurred but its after image could not be saved. A retention value of zero
disables new artifacts. **Delete action screenshots** removes the run's saved images;
existing backups and images already sent to a provider have separate lifecycles.
Deletion and expiry apply to live database records, not forensic erasure of SQLite
pages or prior backups. Model screenshots remain only in the active run context.

## Pause, revocation, stop and recovery

Pause aborts in-flight input, releases held modifiers/buttons, cancels approvals and
blocks further agent actions. Normal pause can be resumed; private takeover cannot.
Close desktop permanently revokes that run's session. Profile changes/archive and
scheduled grant changes revoke sessions and pending approvals. Emergency stop
aborts runs, releases input, closes every desktop, and keeps the global stop latch
until explicitly cleared.

A separate supervisor watches the API's pipe. API death, including SIGKILL, terminates
Xvfb and the sandbox; cleanup has a bounded forced-kill fallback. On restart, the
backend removes abandoned temporary session files and marks interrupted runs and
approvals failed/cancelled. It never reopens a desktop or replays clicks/keystrokes.

## Scheduled runs

Jobs default to computer access **Off**, even if their profile grants Control. A user
must explicitly declare isolated Observation or Control in the job. The declaration
can only reduce profile permissions. Observation is suitable for unattended use;
Control still pauses for each human approval and never assumes unattended consent.
Approval deadlines, private takeover, action/time budgets, profile revocation and
emergency stop apply equally. Scheduled tasks have no route to the real desktop.

## Validation

- Real Xvfb tests cover screenshots at 800×600 and 1024×768, app/window selection,
  approved input, denial, changed geometry/foreground, private takeover, screenshot
  pairs, action/time budgets, prompt-injection text, interrupted drag/typing and
  cleanup.
- A real Bubblewrap test verifies backend files, provider environment values, host
  processes and backend loopback are inaccessible.
- HTTP tests cover authentication, model screenshots, batched tool ordering,
  approvals/revocation, private manual input, authenticated artifacts/deletion,
  scheduled declarations and emergency stop.
- An actual API SIGKILL/restart test verifies desktop process termination, abandoned
  session cleanup, cancelled approvals and no automatic input replay.
- UI tests cover grants/budgets/retention, preview, observation controls, private
  takeover, cleared manual input and artifact retrieval/deletion.
