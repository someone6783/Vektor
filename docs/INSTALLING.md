# Installing Vektor

Download the desktop installer directly, or download `install.sh` / `install.ps1`
from the same [GitHub release](https://github.com/someone6783/Vektor/releases/latest).
Scripts verify every downloaded asset against that release's SHA256SUMS before
installing. Run them as your normal desktop account. Desktop releases support Linux
x64 and Windows x64; Docker images support Linux amd64 and arm64.

## Desktop

On Linux, `bash install.sh` installs the .deb with apt on Debian/Ubuntu, including
its runtime dependencies. apt may request administrator credentials. Other systems
use an extracted AppImage in your user account; `--appimage` also selects this path
on Debian/Ubuntu. It avoids requiring FUSE, but still requires GTK 3, WebKitGTK 4.1, Chromium system dependencies,
and an AppIndicator tray host from your distribution. Open Vektor in the applications
menu. Windows users run `.\install.ps1` or the downloaded setup.exe; NSIS installs
for the current user and offers to launch Vektor. Windows normally supplies WebView2;
the installer handles its bootstrap when needed.

Choose **Install local API service** to install the bundled Node, API and Chromium. No Node
installation, Docker, terminal command, service password or token entry is required.
The API only listens on 127.0.0.1. Setup prefers port 8787, selecting a free port if
Docker or another application already uses it. The connection is saved automatically.

Linux registers `vektor-api.service` with `systemd --user`. A functioning user
systemd manager is required. It starts at login; it does not enable lingering or
promise to run after logout. Windows registers `Vektor API - <username>` in Task
Scheduler with the current user's interactive token and least privileges. A private
windowless native host runs the Node supervisor, without leaving a console open.
It runs while that user is signed in, including on battery, without a time limit.
Services restart on failure; normal stops do not trigger restart.

Closing the desktop window hides it in the tray so agents can finish. Reopening
the application focuses the existing instance. Choose **Quit Vektor and stop local API**
to gracefully stop the owned service and exit. In-flight work is cancelled through
the API's normal shutdown/recovery path. The next desktop launch starts it again;
the login trigger also starts it after your next sign-in. Killing only the desktop
process does not stop the independent API.

Data lives under the Tauri application local-data directory:

- Linux: `${XDG_DATA_HOME:-~/.local/share}/app.vektor.desktop/data`
- Windows: `%LOCALAPPDATA%\app.vektor.desktop\data`

Installed runtimes live beside `data` under `backend/<version>-<build-id>`. On launch,
the desktop refreshes an outdated local API from its bundled payload, including
same-version development builds. The service keeps its existing data and port. Credentials and
configuration are private to your user (0700 directories/0600 files on Unix, inherited
user-profile ACLs on Windows). API logs are in `data/logs`. Never delete this directory
to repair the desktop; it contains your workspace, database and encryption key.

## Docker

Install Docker Engine with Compose v2 or Docker Desktop first. The account launching
the desktop/installer must have access to the local Docker daemon. The desktop does
not escalate privileges or change Docker socket permissions. Remote TCP/SSH contexts
are not used for automatic credential discovery.

```bash
bash install.sh --docker
bash install.sh --open
# Or use an existing project directory, preserving its Compose project identity:
bash install.sh --docker --directory /path/to/existing/project --version 0.1.0
```

```powershell
.\install.ps1 -Docker
.\install.ps1 -Open
.\install.ps1 -Docker -Directory C:\Vektor -Version 0.1.0
```

The installer creates a persistent project directory (Linux XDG data/vektor-docker;
Windows LocalAppData/Vektor-Docker), pins both image versions in `release.env`, pulls
images and waits for health. A user `.env` is read before the release pins. Re-running
preserves existing `compose.yaml`, saving the new template as `compose.release.new.yaml`.
Review that template when upgrading an older combined deployment; keep the original
Compose project name and `vektor-data` volume. Custom ports require corresponding
launcher/proxy configuration; the provided sign-in launcher assumes the defaults.

The `vektor` service owns the API and existing data volume, publishing loopback port 8787. The `web` service runs static assets in its own non-root nginx container on
loopback port 8788, proxying API/auth routes internally. It has no data-volume mount,
Docker socket or embedded credential. SSE and uploads pass through without buffering;
nginx resolves the API again when its container is replaced. API storage and schedules
continue independently of the web container and desktop. The historical all-in-one
image remains available for existing deployments; split Compose disables its embedded
web server. Source builds use Dockerfile targets `api` and `web`.

The installer opens a two-minute, single-use browser link. Only an already authenticated
API caller can mint it; the fragment is removed before exchanging it. The browser
receives a signed HttpOnly/SameSite=Strict cookie, valid for thirty days and bound to
the instance's access token. Restarting the API preserves sessions; rotating that token
invalidates them. API cookie authentication checks local Host and same-origin requests.
Bearer clients continue working. `--open` / `-Open` creates a fresh sign-in link without
changing containers. On a headless machine the Linux script prints the short-lived
link; do not share it. No unauthenticated endpoint returns the persistent API token.

In desktop setup choose **Connect to Docker** and use `http://127.0.0.1:8787` (or the
API's remapped loopback port). Native setup locates the Compose `vektor` container,
reads its credential through Docker exec and validates it before saving. Use the API
port, not the web port. Quitting the tray leaves Docker running; use `docker compose
--env-file release.env stop` from its project directory to stop containers explicitly.

## Service troubleshooting and removal

For Linux, inspect `systemctl --user status vektor-api` and the private API logs.
For Windows, inspect the Vektor API task's last result and the private API logs.
Do not start two APIs against the same data directory; startup enforces a data lock.

Before uninstalling the desktop, stop the local API from the tray. Remove its login
registration with `systemctl --user disable --now vektor-api` on Linux, or delete
`Vektor API - <username>` from Task Scheduler on Windows. Keep the data directory for
reinstallation or back it up before deleting it. Package removal preserves per-user
service/data files. Desktop updates do not silently replace a running API runtime:
finish work and back up data before changing an installed backend version.

The optional Docker host updater supports combined and split deployments. It verifies
both release image versions/digests before stopping the API, backs up the stopped data,
updates both containers together and preserves installer image pins. See [updates](UPDATES.md)
and [backup and recovery](OPERATIONS.md) before upgrading.
