# Release operations

Release automation includes update checks and click-to-install desktop/Docker updates.
See [UPDATES.md](UPDATES.md) for installation and host helper setup.
[v0.1.0 was published on 2026-11-01](https://github.com/someone6783/Vektor/releases/tag/v0.1.0)
with verified Windows/Linux update signatures, public amd64/arm64 Docker images and
attached BuildKit attestations. Anonymous registry access, a credential-free pull,
published-image startup/auth/Web UI checks, release checksums and live GitHub update
metadata/signatures passed. Windows GUI installation/replacement remains unverified.

## Version and repository metadata

Edit only the root `package.json` version, then run `pnpm version:sync`. Commit the
generated shared constants, workspace package versions, Rust package/lock version,
Docker version/source labels and release locations. Tauri reads the root package
version directly. Versions must be canonical semver usable as Docker tags; use a
prerelease suffix for previews and omit build metadata (`+...`). The repository URL
and explicit `vektor.releaseRepositoryPrivate` flag also live at the root. The
generator keeps the desktop release-link capability and compose image aligned.

`pnpm version:check` is read-only and fails on stale metadata. Release validation
also requires a clean tracked checkout, a tag exactly equal to `v<root version>`,
that tag pointing at HEAD, and the expected GitHub repository. Only published stable
versions can be advertised by update checks; a newer prerelease never appears as an
available update. Prerelease images receive only their full version tag. Stable
images receive full version, major.minor, and latest aliases. The workflow refuses
to move stable aliases backwards when a newer stable GitHub Release exists.

## Prepare and publish

Before creating a tag, complete and commit these checks:

```sh
pnpm install --frozen-lockfile
pnpm version:check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm desktop:check
pnpm --filter @vektor/web exec tauri build --bundles deb
pnpm release:pack
pnpm release:verify
docker build -t vektor:release-check .
python3 scripts/verify-phase7.py --image vektor:release-check
```

Browser-enabled host installations also need the pinned Chromium and OS dependencies described in [BROWSER.md](BROWSER.md). Docker packages them and CI runs the deterministic browser smoke before publishing.

The API archive must be built on Linux x64 with Node 22 because it contains native
SQLite dependencies. `release:verify` extracts it into a temporary directory, starts
the production server with fresh data, checks health/version, web assets, API bearer
auth and update opt-out, verifies checksums, then shuts down and removes its data.
Use `--sudo` on the Docker verification script when required locally. The desktop packages require the Linux prerequisites in the README. Release CI signs
the AppImage using `TAURI_SIGNING_PRIVATE_KEY`; Windows x64 NSIS installers are built on Windows runners; macOS packaging remains separate work.

When publication is intended, create and push the version tag on the verified
commit. For example, with version 0.1.0:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Alternatively dispatch the Release workflow with an existing version tag. CI runs
on pushes and pull requests; release jobs independently repeat verification before
the publish job receives write access. The publish job reserves a draft release,
builds amd64 and arm64 with QEMU/Buildx, pushes to GHCR using the workflow's ephemeral
GITHUB_TOKEN, and embeds BuildKit `mode=max` provenance in the OCI index. Version,
source, checked-out revision and UTC creation date are image labels. No credentials
are passed as build arguments. This is BuildKit provenance, not a separately signed
GitHub attestation claim. The registry and repository stay private unless an owner
changes their visibility independently.

API/web archives, compose.yaml, release metadata, Windows x64 signed setup installers, Linux x64 desktop `.deb`, signed AppImage and host updater/installer files, plus
SHA256SUMS become release assets. Notes include the image digest and upgrade steps.
The release becomes visible only after assets are uploaded. Failed publication can
leave a draft release or pushed image tags; dispatch the same tag to retry a draft.
Published releases cannot be overwritten by this workflow. There is no atomic
transaction across GHCR and GitHub Releases.

If publishing alone failed after all build jobs passed, dispatch the current Release
workflow with the same tag and optional `artifact_run` input set to that prior run ID.
The workflow verifies the exact tagged commit and successful server, Windows and
Linux build jobs before reusing their signed artifacts. It normalizes desktop
artifact subdirectories before generating release checksums. Published releases
remain protected from overwrite.

The workflow needs repository Actions enabled and GITHUB_TOKEN permissions to write
repository contents and GHCR packages. An existing GHCR package may require granting
this repository Actions access. No personal publisher token is required by the code.

## Install and upgrade

Download compose.yaml from the intended release into the existing Vektor project
directory, preserving the compose project name and all existing environment/resource
overrides. The release compose file uses a prebuilt image; the source compose file
continues to build the local checkout. A private image needs Docker authentication
with `read:packages` access. Authenticate using Docker's normal credential workflow.
Back up the stopped backend as described in [OPERATIONS.md](OPERATIONS.md), then:

```sh
export VEKTOR_IMAGE=ghcr.io/someone6783/vektor:0.1.0
docker compose pull && docker compose up -d
```

This preserves the existing `vektor-data` volume in the same compose project. Do not
run `docker compose down -v`. Verify `/healthz`, the reported version, saved files,
profiles and a short run before explicitly resuming schedules. Keep the previous
image and verified pre-upgrade backup. Rollback uses a fresh volume restored from
that backup, not an older binary against migrated data.

To run the API archive, verify SHA256SUMS, extract it, set absolute
`VEKTOR_DATA_DIR` and `VEKTOR_WEB_DIST` (the latter points to extracted `web/dist`),
then run `node api/dist/server.js` with Node 22 on Linux x64. Desktop users install
the `.deb` and manage the backend separately. Updates are checked automatically and installed when clicked; see [UPDATES.md](UPDATES.md).
Neither desktop nor Docker silently installs updates. The release link opens in the system browser from
the desktop, limited to this repository's release tag URLs.

## First publication demonstration

After an authorized real tag push, verify both platform manifests and attached
provenance using `docker buildx imagetools inspect` on the published digest. Pull
and run the image, compare `/healthz`, About, desktop package and OCI version labels
to the tag, and download/verify the release assets. Confirm fresh-volume backup and
restore on the published image.

An older instance with checking enabled should show
the newer stable version, release link and last-check timestamp after Check now or
within the 24-hour cache window. Remove network access and confirm startup/chat/runs
continue with a quiet unable-to-check state. The offline, timeout, cache and older
instance behavior is locally covered with deterministic fixtures; the
published checks have passed using an older-version fixture and the real GitHub release.
An actual GUI-driven desktop update between two published versions is still future work.

Implementation references: [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release),
[Docker build-push action](https://github.com/docker/build-push-action), and
[Tauri opener scopes](https://v2.tauri.app/plugin/opener/).

### Desktop service and split-container installation

Desktop build hooks run `pnpm desktop:prepare` on each target OS. This deploys a
hoisted production API, copies Node 22 and matching Chromium binaries, and strips
package-manager links before Tauri bundles the resources. Windows payloads must be
prepared on Windows so SQLite native modules match. Never reuse a Linux payload in
NSIS. The Windows/Linux build jobs run `verify-desktop-service.mjs` against their
prepared payloads, including browser launch and graceful supervisor shutdown.

The default Docker image retains the combined API/web layout for existing users.
Source Compose uses target `api`; target `web` builds only frontend dependencies
and produces a separate non-root nginx image. Release publishing pushes matching
`vektor` and `vektor-web` tags and versions. `compose.yaml` disables the embedded
frontend in the API container and starts the separate web service. The optional
host updater verifies and pins both digests before replacement.

Release assets also include `install.sh`, `install.ps1`, `open-workspace.mjs` and
`INSTALLING.md` in SHA256SUMS. Keep the scripts and their downloads in the same
versioned release. The Docker installers open an authenticated single-use link;
no long-lived credential is printed. Existing releases without these assets cannot
be installed using the new Docker scripts. CI exercises actual split containers,
streaming, sign-in, proxy reconnection and session persistence across API replacement.
