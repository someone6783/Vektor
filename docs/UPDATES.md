# Updates

Vektor checks for stable releases automatically. Installation requires a click.
Enable checks in About; `VEKTOR_UPDATE_CHECK=0` disables them. Public builds enable
checks by default. Private builds require a read-only GitHub token in About or
`VEKTOR_GITHUB_TOKEN`; it stays encrypted on the backend and is never returned to
the desktop. Update checks do not send conversation or usage data.

## Desktop

Install the Windows x64 **setup.exe**, or use the Linux x64 **AppImage** from a
signed release. Make the AppImage executable and run it from a writable directory. The desktop checks on opening the workspace and every
24 hours. When a newer signed desktop package exists, **Install desktop v… and restart**
appears. Installation verifies the release signature, runs the Windows installer or replaces the AppImage, and
restarts the desktop. Its independently running backend continues working.

Existing `.deb` installations need a one-time switch to the AppImage for in-app
updates. The `.deb` remains available for package-manager installations. Development
Linux executables do not install updates. macOS distribution is not configured.
Windows updater signatures authenticate Vektor updates; an Authenticode publisher
certificate is not configured, so Windows may identify the first installer as an
unknown publisher.

The desktop talks only to the configured loopback backend. The backend fetches
GitHub release metadata and signed assets, including private assets when configured.
Temporary GitHub storage redirects never receive the GitHub credential. Signatures
are verified against the public key shipped in the desktop. Custom updater commands
fix the endpoint to loopback; generic updater commands are not exposed to the UI.

Release CI verifies each desktop update signature against the public key shipped to clients
before it uploads release artifacts.

Release CI needs `TAURI_SIGNING_PRIVATE_KEY` in repository Actions secrets. The
matching public key is committed in `apps/web/src-tauri/tauri.conf.json`. Keep an
independent secure backup of the private key: changing it strands older clients.
The current local key is outside the repository at `~/.local/share/vektor/updater.key`.

## Docker API and Web UI

The API and Web UI ship together in one image. The optional Python host updater
runs outside the container with Docker access. The API receives only a small update
queue directory, never the Docker socket. The host accepts only a stable version
number and request UUID; it controls the image repository and Compose project.

One-time setup requires Python 3 and Docker Compose v2. Download `compose.yaml`,
`docker-updater.py` and `install-docker-helper.py` from the same release into one
folder. Use the existing Compose project name and preserve its data volume. The
source-build Compose file is not supported.

On Linux, run:

```sh
sudo python3 install-docker-helper.py --compose /absolute/path/compose.yaml --project YOUR_EXISTING_PROJECT
```

The installer takes a private snapshot of the resolved Compose configuration,
preserves its project, volumes, ports and environment, adds the queue mount, and
recreates the existing backend using that snapshot. It installs and starts the
`vektor-docker-updater` systemd service, enabled at boot. Its configuration, queue
and backups live under `/var/lib/vektor-updates`. View logs with
`sudo journalctl -u vektor-docker-updater`; stop it with
`sudo systemctl disable --now vektor-docker-updater`.

On Windows with Docker Desktop, run this in a normal, **non-administrator** terminal:

```powershell
python install-docker-helper.py --compose C:\Vektor\compose.yaml --project YOUR_EXISTING_PROJECT
```

It installs for the current Docker Desktop user under
`%LOCALAPPDATA%\Vektor\docker-updater`, protects the snapshot and backups with that
user's Windows ACL, starts the helper, and adds a per-user Startup shortcut for
future logins. Docker Desktop must be running. The helper log is `helper.log` in
that directory. Remove **Vektor Docker updater** from your Startup folder to disable
future starts. No administrator Windows service or password is needed.

After installation, use the printed managed `compose.json` for future Compose
changes and manual commands, keeping the same `--project-name`. Rerun the installer
after changing your original configuration to refresh the managed snapshot. Keep
that snapshot private: it can contain resolved environment credentials. The
helper never receives commands or image URLs from the application, and the
application never receives a Docker socket. Authenticate Docker to GHCR first if
the image is private.

For custom service managers, run `docker-updater.py --help`. The optional
`compose.updates.yaml` release asset provides the queue mount for manual setups;
include it in your resolved managed configuration so upgrades preserve it.

With the helper running, a newer release exposes **Install latest backend update**
in Vektor. Finish active runs first. Clicking latches emergency stop, downloads the
image, checks its version label, pins its registry digest, stops the backend, copies
its complete `/data` tree into a timestamped private backup, and recreates only the
existing service. It checks `/healthz` and the reported version before marking the
update complete. Reload the Web UI after reconnecting and explicitly resume
execution after verifying the workspace. Schedules cannot execute during the update.

A download or backup failure preserves the old image; a backup failure restarts the
old stopped container. A failure after replacement stops the backend and retains
the backup. Never automatically run an older binary against migrated data. To roll
back, restore the saved `data/` tree into a **fresh** Docker volume, preserving file
ownership, and start the previous image recorded in `metadata.json` against it.
Never delete the current volume until the restored workspace is verified.

The helper discards queued requests on startup so a host restart cannot replay an
installation. Its heartbeat makes the install action unavailable when the helper
is down. Backups are not automatically deleted; manage their retention on the host.

## CI and publication

Push/PR CI builds and tests the API and Web UI, verifies their packaged archive,
and builds Windows x64 setup installers and Linux x64 desktop `.deb` and AppImage artifacts. Its Docker update smoke
check uses disposable containers to verify backup, actual replacement, health, data
preservation and the persistent stop latch; only registry metadata/pulls use local fixtures. Release CI repeats those
checks, signs the Windows installer and AppImage and publishes their `.sig` files, plus the API/Web UI
archives, host updater, Compose files and checksums. Docker images are published
for linux/amd64 and linux/arm64. Desktop distribution targets Windows x64 and Linux x64.

No update can appear until a newer stable `v<version>` tag has passed Release CI
and its GitHub Release has been published. An existing installation must first
receive this update-capable build through its normal installation method.
