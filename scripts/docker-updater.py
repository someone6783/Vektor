#!/usr/bin/env python3
"""Host-side, click-triggered Vektor updater. The application never gets a Docker socket.

Run as a user with Docker access. The queue directory is shared with the API container;
only a stable version and request UUID are accepted, never commands or image URLs.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import uuid
import urllib.request
import sys
import stat

VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")
IMAGE = "ghcr.io/someone6783/vektor"


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True,
                          timeout=600, **kwargs).stdout.strip()


def atomic_json(path, value):
    # The API can write the queue: never follow queue-supplied symlinks as root.
    temporary = path.parent / (".host-" + str(uuid.uuid4()) + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(json.dumps(value))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_request(value):
    if not isinstance(value, dict) or set(value) != {"id", "version"}:
        raise ValueError("Invalid update request.")
    if str(uuid.UUID(value["id"])) != value["id"] or not VERSION.fullmatch(value["version"]):
        raise ValueError("Invalid request ID or stable version.")
    return value


class Updater:
    def __init__(self, args):
        self.args = args
        self.directory = Path(args.queue).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        # API container runs as uid/gid 1001. Queue needs group write, no world access.
        if os.name != "nt":
            os.chown(self.directory, -1, args.group)
            self.directory.chmod(0o2770)
        self.backups = Path(args.backups).resolve()
        self.backups.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = os.fdopen(os.open(self.backups / ".updater.lock", os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600), "w")
        if os.name == "nt":
            import msvcrt
            self.lock.write("0")
            self.lock.flush()
            self.lock.seek(0)
            msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.state = {"state": "idle", "version": None, "message": "Docker updater is ready."}
        self.mutex = threading.Lock()
        self.worker = None
        self.compose = ["docker", "compose", "--project-directory", str(Path(args.compose).resolve().parent),
                        "--project-name", args.project, "-f", str(Path(args.compose).resolve())]
        self.previous = None
        self.stopped = False
        self.replacing = False
        # A host reboot must not replay an installation request or hide an interrupted update.
        try:
            fd = os.open(self.directory / "status.json", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
            with os.fdopen(fd, "r") as previous:
                info = os.fstat(previous.fileno())
                old_state = json.loads(previous.read(4096)) if stat.S_ISREG(info.st_mode) and info.st_size <= 4096 else {}
            if old_state.get("state") in {"queued", "pulling", "backing_up", "installing"}:
                self.state.update(state="failed", message="The previous update was interrupted. Check backend health and backups before retrying; no work was replayed.")
        except (OSError, ValueError, AttributeError):
            pass
        request = self.directory / "request.json"
        if request.exists():
            request.unlink()
            self.state.update(state="failed", message="Updater restarted; any pending request was discarded. Check the backend before trying again.")

    def update_state(self, state, message, version=None):
        with self.mutex:
            self.state.update(state=state, message=message)
            if version:
                self.state["version"] = version

    def write_status(self):
        with self.mutex:
            atomic_json(self.directory / "status.json", {**self.state, "heartbeat": int(time.time() * 1000)})

    def install(self, request):
        version = request["version"]
        try:
            self.previous = None
            self.stopped = False
            self.replacing = False
            self.update_state("pulling", f"Downloading backend v{version}.", version)
            container = run(self.compose + ["ps", "-q", self.args.service])
            if not container or "\n" in container:
                raise ValueError("Exactly one running backend is required.")
            old = json.loads(run(["docker", "inspect", container]))[0]
            self.previous = old["Image"]
            current = old.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.version", "")
            core = current.split("-", 1)[0]
            if not VERSION.fullmatch(core) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", current):
                raise ValueError("Installed image has no valid version label.")
            target_version, current_version = tuple(map(int, version.split("."))), tuple(map(int, core.split(".")))
            if target_version < current_version or (target_version == current_version and "-" not in current):
                raise ValueError("Refusing an equal or older backend version.")
            # Independently verify the requested version is the published stable release.
            req = urllib.request.Request("https://api.github.com/repos/someone6783/Vektor/releases/latest", headers={"User-Agent": "Vektor-host-updater"})
            with urllib.request.urlopen(req, timeout=15) as response:
                release = json.loads(response.read(1024 * 1024))
            if release.get("tag_name") != "v" + version or release.get("draft") or release.get("prerelease"):
                raise ValueError("Requested version is not the latest published stable release.")
            # Preserve the existing service and data volume; refuse source builds or
            # configurations whose image is not controlled by VEKTOR_IMAGE.
            target = f"{IMAGE}:{version}"
            env = {**os.environ, "VEKTOR_IMAGE": target, "VEKTOR_WEB_IMAGE": f"{IMAGE}-web:{version}"}
            config = json.loads(run(self.compose + ["config", "--format", "json"], env=env))
            service = config["services"][self.args.service]
            if service.get("image") != target or service.get("build"):
                raise ValueError("Use compose.release.yaml with the VEKTOR_IMAGE override and no source build.")
            run(["docker", "pull", target])
            image = json.loads(run(["docker", "image", "inspect", target]))[0]
            if image.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.version") != version:
                raise ValueError("Downloaded image version does not match the requested release.")
            # Pin the image digest after pulling; a moving tag cannot race installation.
            digests = [d for d in image.get("RepoDigests", []) if d.startswith(IMAGE + "@sha256:")]
            if not digests:
                raise ValueError("Downloaded image has no registry digest.")
            env["VEKTOR_IMAGE"] = digests[0]
            services = [self.args.service]
            web = config["services"].get("web")
            if web:
                web_target = f"{IMAGE}-web:{version}"
                if web.get("image") != web_target or web.get("build"):
                    raise ValueError("The web image must use VEKTOR_WEB_IMAGE with the matching release version.")
                run(["docker", "pull", web_target])
                web_image = json.loads(run(["docker", "image", "inspect", web_target]))[0]
                if web_image.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.version") != version:
                    raise ValueError("Downloaded web image version does not match the release.")
                web_digests = [d for d in web_image.get("RepoDigests", []) if d.startswith(IMAGE + "-web@sha256:")]
                if not web_digests:
                    raise ValueError("Downloaded web image has no registry digest.")
                env["VEKTOR_WEB_IMAGE"] = web_digests[0]
                services.append("web")
            self.update_state("backing_up", "Stopping the backend and backing up its data.")
            run(self.compose + ["stop", "--timeout", "30", self.args.service])
            self.stopped = True
            backup = self.backups / (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + request["id"])
            backup.mkdir(mode=0o700)
            # Copy the complete, stopped /data tree, including browser profiles and
            # attachments. Failure aborts replacement and restarts the old container.
            run(["docker", "cp", container + ":/data/.", str(backup / "data")])
            atomic_json(backup / "metadata.json", {"previousImage": self.previous, "targetImage": digests[0], "version": version})
            self.update_state("installing", f"Backup saved at {backup}. Installing v{version}.")
            self.replacing = True
            run(self.compose + ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "120"] + services, env=env)
            new_container = run(self.compose + ["ps", "-q", self.args.service], env=env)
            health = json.loads(run(["docker", "exec", new_container, "node", "-e",
                "fetch('http://127.0.0.1:8787/healthz').then(async r => {if(!r.ok) process.exit(1); console.log(JSON.stringify(await r.json()))}).catch(() => process.exit(1))"]))
            if health.get("version") != version:
                raise ValueError("Backend health version does not match the requested update.")
            # Installer-managed projects keep their image pins for subsequent restarts.
            pins = Path(self.args.compose).resolve().parent / "release.env"
            if pins.exists():
                if pins.is_symlink() or not pins.is_file():
                    raise ValueError("Refusing a non-regular release.env file.")
                temporary = pins.with_name(".release-" + str(uuid.uuid4()) + ".tmp")
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as output:
                    output.write("VEKTOR_IMAGE=" + env["VEKTOR_IMAGE"] + "\n")
                    if web:
                        output.write("VEKTOR_WEB_IMAGE=" + env["VEKTOR_WEB_IMAGE"] + "\n")
                os.replace(temporary, pins)
            self.update_state("complete", f"Backend and Web UI updated to v{version}. Reload the page, verify the workspace, then resume execution. Backup: {backup}")
        except Exception as error:
            print(f"Vektor update failed: {error}", file=sys.stderr, flush=True)
            # Never run an old binary against potentially migrated data.
            if self.stopped and not self.replacing:
                try:
                    run(self.compose + ["start", self.args.service])
                except Exception:
                    pass
            if self.replacing:
                try:
                    run(self.compose + ["stop", self.args.service])
                except Exception:
                    pass
            self.update_state("failed", "Update failed. Check the host updater logs and backups. If replacement started, the backend was stopped; restore the backup to a fresh volume before rolling back.")

    def serve(self):
        while True:
            self.write_status()
            request_path = self.directory / "request.json"
            if not (self.worker and self.worker.is_alive()) and request_path.exists():
                try:
                    if request_path.is_symlink():
                        raise ValueError("Symlink requests are not accepted.")
                    fd = os.open(request_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
                    with os.fdopen(fd, "r") as source:
                        info = os.fstat(source.fileno())
                        if not stat.S_ISREG(info.st_mode) or info.st_size > 1024:
                            raise ValueError("Invalid request file.")
                        request = validate_request(json.loads(source.read(1025)))
                    request_path.unlink()
                    self.update_state("queued", f"Queued backend v{request['version']}.", request["version"])
                    self.worker = threading.Thread(target=self.install, args=(request,), daemon=False)
                    self.worker.start()
                except (ValueError, TypeError, KeyError, OSError):
                    request_path.unlink(missing_ok=True)
                    self.update_state("failed", "Invalid update request discarded.")
            time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose", required=True, help="Existing release compose.yaml (all overrides must be in this file)")
    parser.add_argument("--project", required=True, help="Existing Compose project name; must not change")
    parser.add_argument("--service", default="vektor")
    parser.add_argument("--queue", required=True)
    parser.add_argument("--backups", required=True)
    parser.add_argument("--group", type=int, default=1001)
    Updater(parser.parse_args()).serve()


if __name__ == "__main__":
    main()
