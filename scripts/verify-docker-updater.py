#!/usr/bin/env python3
"""Exercise real Docker replacement/backup using local images and release fixtures.

Only registry pull/metadata are substituted. All Compose operations, data copying,
container shutdown/recreation and health checks run against disposable resources.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch, MagicMock
import uuid
import sys

spec = importlib.util.spec_from_file_location("updater", Path(__file__).with_name("docker-updater.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
base = sys.argv[1] if len(sys.argv) > 1 else "vektor:update-check"
web_base = sys.argv[2] if len(sys.argv) > 2 else None
project = "vektor-update-smoke-" + uuid.uuid4().hex[:10]
fixture = project + ":new"
web_fixture = project + ":web"
real_run = updater.run
current = json.loads(real_run(["docker", "image", "inspect", base]))[0]["Config"]["Labels"]["org.opencontainers.image.version"]
parts = list(map(int, current.split("-", 1)[0].split(".")))
version = f"{parts[0]}.{parts[1]}.{parts[2] + 1}"

with TemporaryDirectory(prefix="vektor-update-smoke-") as tmp:
    root = Path(tmp)
    compose = root / "compose.yaml"
    definition = {"services": {"vektor": {
        "image": "${VEKTOR_IMAGE:-" + base + "}",
        "volumes": ["data:/data", str(root / "queue") + ":/run/vektor-updates"],
        "environment": {"VEKTOR_UPDATE_CHECK": "0", "VEKTOR_UPDATE_DIR": "/run/vektor-updates"},
        "healthcheck": {"interval": "1s", "start_period": "1s", "timeout": "5s", "retries": 30}
    }}, "volumes": {"data": {}}}
    if web_base:
        definition["services"]["web"] = {"image": "${VEKTOR_WEB_IMAGE:-" + web_base + "}", "depends_on": {"vektor": {"condition": "service_healthy"}}}
        (root / "release.env").write_text("VEKTOR_IMAGE=old\nVEKTOR_WEB_IMAGE=old\n")
    compose.write_text(json.dumps(definition))
    helper = updater.Updater(SimpleNamespace(compose=str(compose), project=project,
        service="vektor", queue=str(root / "queue"), backups=str(root / "backups"), group=1001))
    try:
        dockerfile = (f"FROM {base}\nUSER root\n"
            f"RUN sed -i 's/{current}/{version}/g' /app/node_modules/@vektor/shared/dist/build-info.js\n"
            f"LABEL org.opencontainers.image.version=\"{version}\"\nUSER vektor\n")
        subprocess.run(["docker", "build", "-t", fixture, "-"], input=dockerfile,
                       text=True, check=True, stdout=subprocess.DEVNULL)
        if web_base:
            subprocess.run(["docker", "build", "-t", web_fixture, "-"], input=f'FROM {web_base}\nLABEL org.opencontainers.image.version="{version}"\n', text=True, check=True, stdout=subprocess.DEVNULL)
        real_run(helper.compose + ["up", "-d", "--wait", "--wait-timeout", "120"])
        old_web = real_run(helper.compose + ["ps", "-q", "web"]) if web_base else None
        old = real_run(helper.compose + ["ps", "-q", "vektor"])
        real_run(["docker", "exec", old, "sh", "-c", "mkdir -p /data/workspace; echo retained > /data/workspace/update-smoke.txt"])
        token = real_run(["docker", "exec", old, "cat", "/data/access-token"])
        # Install route/latch/queue behavior is covered by the API integration test.
        # This packaged check exercises the resulting stopped state through replacement.
        real_run(["docker", "exec", old, "node", "-e",
            "fetch('http://127.0.0.1:8787/api/runtime/emergency-stop',{method:'POST',headers:{Authorization:'Bearer '+process.argv[1]}}).then(r=>{if(!r.ok)process.exit(1)})", token])
        digest = updater.IMAGE + "@sha256:" + "a" * 64
        web_digest = updater.IMAGE + "-web@sha256:" + "b" * 64

        def docker_fixture(command, **kwargs):
            if command[:2] == ["docker", "pull"]:
                return "Local registry fixture"
            if command[:3] == ["docker", "image", "inspect"]:
                is_web = command[-1].startswith(updater.IMAGE + "-web:")
                image = json.loads(real_run(["docker", "image", "inspect", web_fixture if is_web else fixture]))
                image[0]["RepoDigests"] = [web_digest if is_web else digest]
                return json.dumps(image)
            if "env" in kwargs and kwargs["env"].get("VEKTOR_IMAGE") == digest:
                kwargs["env"] = {**kwargs["env"], "VEKTOR_IMAGE": fixture}
            if "env" in kwargs and kwargs["env"].get("VEKTOR_WEB_IMAGE") == web_digest:
                kwargs["env"] = {**kwargs["env"], "VEKTOR_WEB_IMAGE": web_fixture}
            return real_run(command, **kwargs)

        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"tag_name": "v" + version, "draft": False, "prerelease": False}).encode()
        with patch.object(updater, "run", side_effect=docker_fixture), patch.object(updater.urllib.request, "urlopen", return_value=response):
            helper.install({"id": str(uuid.uuid4()), "version": version})
        assert helper.state["state"] == "complete", helper.state
        new = real_run(helper.compose + ["ps", "-q", "vektor"])
        assert new != old
        if web_base:
            assert real_run(helper.compose + ["ps", "-q", "web"]) != old_web
            assert web_digest in (root / "release.env").read_text()
            assert digest in (root / "release.env").read_text()
        assert real_run(["docker", "exec", new, "cat", "/data/workspace/update-smoke.txt"]) == "retained"
        assert real_run(["docker", "exec", new, "cat", "/data/access-token"]) == token
        check = real_run(["docker", "exec", new, "node", "-e",
            "fetch('http://127.0.0.1:8787/api/runtime',{headers:{Authorization:'Bearer '+process.argv[1]}}).then(async r=>console.log((await r.json()).emergencyStopped))", token])
        assert check == "true"
        backup = next((root / "backups").glob("*/data"))
        assert (backup / "workspace/update-smoke.txt").read_text().strip() == "retained"
        assert (backup / "access-token").read_text().strip() == token
        if web_base:
            print("Split update: web replacement, matching release digests and persistent image pins passed.")
        print(f"Docker update {current} -> {version}: backup, replacement, health, data/token preservation and persistent stop passed.")
    finally:
        helper.lock.close()
        real_run(helper.compose + ["down", "-v", "--remove-orphans"])
        subprocess.run(["docker", "image", "rm", fixture] + ([web_fixture] if web_base else []), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
