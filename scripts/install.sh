#!/usr/bin/env bash
# Vektor Linux installer. Download this script from a trusted Vektor release.
set -euo pipefail
repo=someone6783/Vektor
mode=desktop
version=latest
project_dir="${XDG_DATA_HOME:-$HOME/.local/share}/vektor-docker"
appimage=false
usage() {
  cat <<'HELP'
Vektor installer for Linux
  ./install.sh                     Install the desktop app (API included)
  ./install.sh --docker            Install separate Docker API and web containers
  ./install.sh --open              Open an existing Docker workspace, signed in
  ./install.sh --appimage          Install desktop for this user using AppImage
  ./install.sh --version 0.1.0     Choose a published stable version
  ./install.sh --directory PATH    Docker project directory (keep it for upgrades)
Desktop setup lets you install the local API service or connect to Docker.
Docker requires Docker Engine/Desktop with Compose v2 and access for your user.
HELP
}
while (($#)); do
  case "$1" in
    --desktop) mode=desktop ;;
    --docker) mode=docker ;;
    --open) mode=open ;;
    --appimage) appimage=true ;;
    --version) shift; version="${1:?Missing version}" ;;
    --directory) shift; project_dir="${1:?Missing directory}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage; exit 1 ;;
  esac
  shift
done
[[ "$(uname -s)" == Linux ]] || { echo 'Use install.ps1 on Windows.' >&2; exit 1; }
[[ "$version" == latest || "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Version must be a stable version such as 0.1.0.' >&2; exit 1; }
for tool in curl python3 sha256sum; do command -v "$tool" >/dev/null || { echo "Install $tool and retry." >&2; exit 1; }; done
if [[ "$mode" != desktop ]]; then
  docker compose version >/dev/null || { echo 'Start Docker with Compose v2 and make it accessible to your account.' >&2; exit 1; }
  docker info >/dev/null
fi
work="$(mktemp -d)"
trap 'python3 -c '\''import shutil,sys; shutil.rmtree(sys.argv[1])'\'' "$work"' EXIT
fetch() { curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 "$1" -o "$2"; }
if [[ "$mode" != open ]]; then
  if [[ "$version" == latest ]]; then
    fetch "https://api.github.com/repos/$repo/releases/latest" "$work/release.json"
    version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag_name"].removeprefix("v"))' "$work/release.json")"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'No stable release found.' >&2; exit 1; }
  fi
  release="https://github.com/$repo/releases/download/v$version"
  fetch "$release/SHA256SUMS" "$work/SHA256SUMS"
fi
asset() {
  fetch "$release/$1" "$work/$1"
  python3 - "$work" "$1" <<'PY'
import hashlib, pathlib, sys
root, name = pathlib.Path(sys.argv[1]), sys.argv[2]
entries = [line.split('  ', 1) for line in (root / 'SHA256SUMS').read_text().splitlines()]
expected = [digest for digest, filename in entries if filename == name]
if len(expected) != 1 or hashlib.sha256((root / name).read_bytes()).hexdigest() != expected[0]:
    raise SystemExit('Release checksum verification failed: ' + name)
PY
}
if [[ "$mode" == desktop ]]; then
  [[ "$(uname -m)" == x86_64 ]] || { echo 'Desktop installers currently support x64. Use --docker on ARM64.' >&2; exit 1; }
  if ! $appimage && command -v apt-get >/dev/null && command -v dpkg >/dev/null; then
    name="Vektor_${version}_amd64.deb"
    asset "$name"
    # apt must be able to read the verified package from its private sandbox user.
    chmod 755 "$work"; chmod 644 "$work/$name"
    if ((EUID == 0)); then apt-get install -y "$work/$name"; else sudo apt-get install -y "$work/$name"; fi
    echo 'Vektor installed. Open Vektor from your applications menu to finish setup.'
    if ((EUID != 0)); then /usr/bin/vektor-desktop >/dev/null 2>&1 & fi
  else
    name="Vektor_${version}_amd64.AppImage"
    asset "$name"
    install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/vektor-desktop"
    mkdir -p "$install_dir" "${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    install -m 755 "$work/$name" "$install_dir/Vektor.AppImage"
    # Extraction avoids requiring FUSE. Runtime GTK/WebKit dependencies still apply.
    (cd "$install_dir"; ./Vektor.AppImage --appimage-extract >/dev/null)
    python3 - "$install_dir" "${XDG_DATA_HOME:-$HOME/.local/share}/applications/vektor.desktop" <<'PY'
import pathlib,sys
root = pathlib.Path(sys.argv[1])
quote = lambda s: '"' + str(s).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%') + '"'
pathlib.Path(sys.argv[2]).write_text('[Desktop Entry]\nType=Application\nName=Vektor\nComment=Local AI workspace\nExec=' + quote(root / 'squashfs-root/AppRun') + '\nTerminal=false\nCategories=Office;Utility;\n')
PY
    echo 'Vektor installed in your applications menu. Requires GTK 3 and WebKitGTK 4.1.'
    "$install_dir/squashfs-root/AppRun" >/dev/null 2>&1 &
  fi
  exit 0
fi
mkdir -p "$project_dir"
if [[ "$mode" == docker ]]; then
  asset compose.yaml
  asset open-workspace.mjs
  # A separate project file preserves existing user overrides and volume identity.
  if [[ -e "$project_dir/compose.yaml" ]]; then
    cp "$work/compose.yaml" "$project_dir/compose.release.new.yaml"
    echo "Existing compose.yaml preserved. New template: $project_dir/compose.release.new.yaml"
  else cp "$work/compose.yaml" "$project_dir/compose.yaml"; fi
  cp "$work/open-workspace.mjs" "$project_dir/open-workspace.mjs"
  export VEKTOR_IMAGE="ghcr.io/someone6783/vektor:$version"
  export VEKTOR_WEB_IMAGE="ghcr.io/someone6783/vektor-web:$version"
  # Dedicated env file pins both images without overwriting user .env settings.
  printf 'VEKTOR_IMAGE=%s\nVEKTOR_WEB_IMAGE=%s\n' "$VEKTOR_IMAGE" "$VEKTOR_WEB_IMAGE" > "$project_dir/release.env"
fi
[[ -f "$project_dir/compose.yaml" && -f "$project_dir/open-workspace.mjs" ]] || { echo 'Run --docker once before --open.' >&2; exit 1; }
cd "$project_dir"
compose=(docker compose)
[[ ! -f .env ]] || compose+=(--env-file .env)
compose+=(--env-file release.env -f compose.yaml)
if [[ "$mode" == docker ]]; then
  "${compose[@]}" pull
  "${compose[@]}" up -d --wait --wait-timeout 180
fi
link="$("${compose[@]}" exec -T vektor node --input-type=module < open-workspace.mjs)"
[[ "$link" =~ ^http://127\.0\.0\.1:8788/\?signin=1#setup=[A-Za-z0-9_-]{43}$ ]] || { echo 'Could not create a sign-in link.' >&2; exit 1; }
echo 'Vektor is ready. Opening the web workspace. The API continues running independently.'
if command -v xdg-open >/dev/null && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then xdg-open "$link" >/dev/null 2>&1 || printf '%s\n' "$link"; else printf 'Open this single-use link within two minutes:\n%s\n' "$link"; fi
