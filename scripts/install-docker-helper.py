#!/usr/bin/env python3
"""Install Vektor's Docker host updater for Linux/systemd or Windows/Docker Desktop.

Takes a snapshot of the existing resolved Compose configuration, preserves its project
and volumes, adds the update queue, and starts the existing backend using that snapshot.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def run(command):
    return subprocess.run(command, check=True, text=True, capture_output=True).stdout.strip()


def managed_config(config, service, queue):
    # Work on a deep copy; never replace the caller's original compose file.
    value = json.loads(json.dumps(config))
    backend = value["services"][service]
    image = backend.get("image", "")
    if backend.get("build") or not (image.startswith(("ghcr.io/someone6783/vektor:", "ghcr.io/someone6783/vektor@sha256:")) or image == "${VEKTOR_IMAGE:-ghcr.io/someone6783/vektor:latest}"):
        raise ValueError("Use the published release compose.yaml, without a source build.")
    backend["image"] = "${VEKTOR_IMAGE:-ghcr.io/someone6783/vektor:latest}"
    backend.setdefault("environment", {})["VEKTOR_UPDATE_DIR"] = "/run/vektor-updates"
    volumes = backend.setdefault("volumes", [])
    volumes[:] = [v for v in volumes if v.get("target") != "/run/vektor-updates"]
    volumes.append({"type": "bind", "source": Path(queue).as_posix(), "target": "/run/vektor-updates"})
    return value


def systemd_unit(root, project, service):
    # systemd expands %, $, and backslash itself; argument quoting alone does not stop it.
    def quote(value):
        value = str(value)
        if any(c in value for c in ['\n', '\r', '\\', '$', '%', '"']):
            raise ValueError("Choose an installation path without systemd escape characters.")
        return '"' + value + '"'
    args = [sys.executable, root / "docker-updater.py", "--compose", root / "compose.json",
            "--project", project, "--service", service, "--queue", root / "queue", "--backups", root / "backups"]
    return "\n".join([
        "[Unit]", "Description=Vektor Docker update helper", "After=docker.service network-online.target",
        "Wants=network-online.target", "Requires=docker.service", "", "[Service]", "Type=simple",
        "ExecStart=" + " ".join(map(quote, args)), "Restart=on-failure", "RestartSec=5",
        "UMask=0077", "TimeoutStopSec=700", "", "[Install]", "WantedBy=multi-user.target", "",
    ])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose", required=True, help="Existing release compose.yaml")
    parser.add_argument("--project", required=True, help="Existing Compose project name, unchanged")
    parser.add_argument("--service", default="vektor")
    parser.add_argument("--directory", help="Private installation directory")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.project):
        parser.error("Use the exact, lowercase existing Compose project name.")
    if os.name != "nt" and os.geteuid() != 0:
        parser.error("Run with sudo on Linux so the helper can manage Docker and its service.")
    if os.name == "nt":
        import ctypes
        if ctypes.windll.shell32.IsUserAnAdmin():
            parser.error("Run as your normal Docker Desktop user, without administrator elevation.")
    default = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Vektor/docker-updater" if os.name == "nt" else Path("/var/lib/vektor-updates")
    root = Path(args.directory or default).resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    queue = root / "queue"
    queue.mkdir(exist_ok=True)
    (root / "backups").mkdir(exist_ok=True, mode=0o700)
    if os.name == "nt":
        # Keep configuration snapshots/backups private to the interactive Docker user and SYSTEM.
        identity = run(["whoami"])
        run(["icacls", str(root), "/inheritance:r", "/grant:r", identity + ":(OI)(CI)F", "SYSTEM:(OI)(CI)F"])
    else:
        root.chmod(0o700)
        os.chown(queue, -1, 1001)
        queue.chmod(0o2770)
    original = Path(args.compose).resolve()
    compose = ["docker", "compose", "--project-directory", str(original.parent), "--project-name", args.project, "-f", str(original)]
    config = managed_config(json.loads(run(compose + ["config", "--format", "json"])), args.service, queue)
    target = root / "compose.json"
    # The Docker config may include resolved environment credentials. Never print it.
    target.write_text(json.dumps(config, indent=2) + "\n")
    if os.name != "nt":
        target.chmod(0o600)
    shutil.copyfile(Path(__file__).with_name("docker-updater.py"), root / "docker-updater.py")
    managed = ["docker", "compose", "--project-directory", str(root), "--project-name", args.project, "-f", str(target)]
    run(managed + ["config", "--quiet"])
    run(managed + ["up", "-d", "--no-deps", args.service])
    if os.name == "nt":
        arguments = [str(root / "docker-updater.py"), "--compose", str(target), "--project", args.project,
                     "--service", args.service, "--queue", str(queue), "--backups", str(root / "backups")]
        # Register a per-user login shortcut; no password or admin service required.
        def ps(value):
            return "'" + str(value).replace("'", "''") + "'"
        shortcut = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Startup'),'Vektor Docker updater.lnk'));"
                    "$s.TargetPath=" + ps(sys.executable) + ";$s.Arguments=" + ps(subprocess.list2cmdline(arguments)) + ";$s.WindowStyle=7;$s.Save()")
        run(["powershell", "-NoProfile", "-Command", shortcut])
        log = open(root / "helper.log", "a")
        subprocess.Popen([sys.executable, *arguments], stdout=log, stderr=log,
                         creationflags=subprocess.CREATE_NO_WINDOW, close_fds=True)
        log.close()
    else:
        unit = systemd_unit(root, args.project, args.service)
        Path("/etc/systemd/system/vektor-docker-updater.service").write_text(unit)
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "vektor-docker-updater.service"])
        run(["systemctl", "restart", "vektor-docker-updater.service"])
    print("Docker updater installed and started. Existing project and data volumes were preserved.")
    print("Managed Compose configuration:", target)
    print("Backups:", root / "backups")
    print("Use the managed configuration for future Compose changes; rerun this installer to refresh its snapshot.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        # A subprocess command or output can contain resolved settings. Do not echo it.
        print("Helper installation failed (" + type(error).__name__ + "). Check Docker access and the release Compose configuration.", file=sys.stderr)
        sys.exit(1)
