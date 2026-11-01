#!/usr/bin/env python3
"""Disposable Docker restore/restart verification. No live provider requests."""
import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--image", default="vektor:phase7-check")
parser.add_argument("--sudo", action="store_true")
args = parser.parse_args()
docker_command = (["sudo", "-n"] if args.sudo else []) + ["docker"]
suffix = uuid.uuid4().hex[:10]
volumes = [f"vektor-p7-{suffix}-{kind}" for kind in ["source", "backup", "restored"]]
containers = [f"vektor-p7-{suffix}-{kind}" for kind in ["source", "restored"]]
token = ""
base = ""


def docker(*command, check=True):
    result = subprocess.run(docker_command + list(command), text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(f"Docker {command[0]} failed: {result.stderr.strip()}")
    return result


def connect(container):
    global base
    value = json.loads(docker("inspect", container).stdout)[0]
    port = value["NetworkSettings"]["Ports"]["8787/tcp"][0]["HostPort"]
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            return api("/healthz")
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.1)
    raise RuntimeError("Backend did not become healthy")


def api(path, body=None, method=None, raw=False, content_type="application/json"):
    payload = json.dumps(body).encode() if body is not None and not isinstance(body, bytes) else body
    request = urllib.request.Request(base + path, data=payload, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": content_type})
    with urllib.request.urlopen(request, timeout=5) as response:
        value = response.read()
        return value if raw else json.loads(value)


def finish(run):
    for _ in range(100):
        detail = api(f"/api/runs/{run}/details")
        if detail["run"]["status"] != "running":
            assert detail["run"]["status"] == "completed", detail["run"]["status"]
            return
        time.sleep(0.1)
    raise AssertionError("Run did not finish")


def start(name, volume):
    docker("run", "-d", "--init", "--name", name, "-p", "127.0.0.1::8787", "-v", f"{volume}:/data",
        "-e", "VEKTOR_LOG_MAX_BYTES=4096", "-e", "VEKTOR_LOG_RETAINED_FILES=3", args.image)
    return connect(name)


try:
    for volume in volumes:
        docker("volume", "create", volume)
    docker("run", "--rm", "--user", "0", "-v", f"{volumes[1]}:/backups", args.image, "node", "-e",
        "require('fs').chownSync('/backups',1001,1001);require('fs').chmodSync('/backups',0o700)")
    health = start(containers[0], volumes[0])
    token = docker("exec", containers[0], "cat", "/data/access-token").stdout.strip()
    profile = api("/api/profiles")["profiles"][0]["id"]
    channel = api("/api/channels", {"name": "Restore proof", "profileId": profile})["channel"]["id"]
    boundary = uuid.uuid4().hex
    content = b"Restorable attachment from the Docker verification.\n"
    multipart = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="proof.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode()
        + content + f"\r\n--{boundary}--\r\n".encode())
    attachment = api(f"/api/channels/{channel}/attachments", multipart, content_type=f"multipart/form-data; boundary={boundary}")["attachment"]["id"]
    finish(api(f"/api/channels/{channel}/messages", {"content": "Before backup"})["run"]["id"])
    job = api("/api/jobs", {"name": "Restored job", "profileId": profile, "channelId": channel, "prompt": "Resume after restore",
        "schedule": "daily", "timezone": "Australia/Perth", "enabled": False})["job"]["id"]
    docker("exec", containers[0], "node", "-e", "require('fs').writeFileSync('/data/workspace/proof.txt','Restored workspace',{mode:0o600})")
    api("/api/settings", {"openRouterKey": "synthetic-phase7-provider-key"}, method="PUT")
    api("/api/scheduler/pause", {})
    api("/api/runtime/emergency-stop", {})
    blocked = docker("exec", containers[0], "node", "dist/maintenance/cli.js", "backup", "/tmp/blocked-backup", check=False)
    assert blocked.returncode and "in use" in blocked.stderr
    logs = docker("exec", containers[0], "cat", "/data/logs/vektor.jsonl").stdout
    assert token not in logs and "synthetic-phase7-provider-key" not in logs
    assert all(json.loads(line).get("level") for line in logs.splitlines())
    docker("stop", containers[0])
    docker("run", "--rm", "-v", f"{volumes[0]}:/data", "-v", f"{volumes[1]}:/backups", args.image,
        "node", "dist/maintenance/cli.js", "backup", "/backups/snapshot")
    docker("run", "--rm", "-v", f"{volumes[1]}:/backups:ro", args.image,
        "node", "dist/maintenance/cli.js", "verify", "/backups/snapshot")
    restore_command = ["run", "--rm", "-v", f"{volumes[2]}:/data", "-v", f"{volumes[1]}:/backups:ro", args.image,
        "node", "dist/maintenance/cli.js", "restore", "/backups/snapshot"]
    docker(*restore_command)
    assert docker(*restore_command, check=False).returncode
    restored = start(containers[1], volumes[2])
    assert restored["instanceId"] == health["instanceId"]
    assert docker("exec", containers[1], "cat", "/data/access-token").stdout.strip() == token
    assert api("/api/settings")["openRouterSource"] == "stored"
    assert api(f"/api/attachments/{attachment}/content", raw=True) == content
    assert docker("exec", containers[1], "cat", "/data/workspace/proof.txt").stdout == "Restored workspace"
    assert api("/api/scheduler")["paused"] and api("/api/runtime")["emergencyStopped"]
    # The synthetic encrypted key proves key preservation; remove it before running the stub.
    api("/api/settings", {"openRouterKey": None}, method="PUT")
    api("/api/runtime/resume", {})
    api("/api/scheduler/resume", {})
    finish(api(f"/api/jobs/{job}/run", {})["execution"]["runId"])
    finish(api(f"/api/channels/{channel}/messages", {"content": "After restore"})["run"]["id"])
    report = api("/api/usage?provider=stub")
    assert report["totals"]["runs"] == 3 and report["totals"]["knownCostUsd"] is None
    assert any(group["id"] == job and group["usage"]["runs"] == 1 for group in report["byJob"])
    assert api("/api/usage?provider=openrouter")["totals"]["runs"] == 0
    interrupted = api(f"/api/channels/{channel}/messages", {"content": "Interrupt the container mid-run"})["run"]["id"]
    docker("kill", "--signal", "KILL", containers[1])
    docker("start", containers[1])
    connect(containers[1])
    detail = api(f"/api/runs/{interrupted}/details")
    assert detail["run"]["status"] == "failed" and "restart" in detail["run"]["error"]
    finish(api(f"/api/runs/{interrupted}/retry", {})["run"]["id"])
    print("PASS: locked maintenance, read-only backup verification, fresh-volume restore, credentials/files/jobs/state, usage attribution, SIGKILL recovery and retry")
finally:
    for container in containers:
        docker("rm", "-f", container, check=False)
    for volume in volumes:
        docker("volume", "rm", volume, check=False)
