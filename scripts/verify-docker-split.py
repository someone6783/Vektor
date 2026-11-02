#!/usr/bin/env python3
"""Real disposable split-container smoke: assets, auth, pairing, SSE and replacement DNS.
Run with an account that can use Docker. Images must already be built.
"""
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import urllib.error
import urllib.request
import uuid

api_image = sys.argv[1] if len(sys.argv) > 1 else "vektor:install-check"
web_image = sys.argv[2] if len(sys.argv) > 2 else "vektor-web:install-check"
project = "vektor-split-smoke-" + uuid.uuid4().hex[:10]

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=180).stdout.strip()

def request(base, path, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        return urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as error:
        return error

with TemporaryDirectory(prefix="vektor-split-") as tmp:
    path = Path(tmp) / "compose.json"
    path.write_text(json.dumps({"services": {
        "vektor": {"image": api_image, "ports": ["127.0.0.1::8787"], "volumes": ["data:/data"],
            "environment": {"VEKTOR_WEB_DIST": "/app/no-web", "VEKTOR_UPDATE_CHECK": "0", "VEKTOR_ENABLE_DEV_STREAM": "1", "VEKTOR_DEV_STREAM_DELAY_MS": "5"},
            "healthcheck": {"interval": "1s", "start_period": "1s", "timeout": "5s", "retries": 30}},
        "web": {"image": web_image, "ports": ["127.0.0.1::8080"], "read_only": True,
            "tmpfs": ["/tmp:size=64m,mode=1777"], "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
            "depends_on": {"vektor": {"condition": "service_healthy"}}},
    }, "volumes": {"data": {}}}))
    compose = ["docker", "compose", "-p", project, "-f", str(path)]
    try:
        run(compose + ["up", "-d", "--wait", "--wait-timeout", "120"])
        base = "http://" + run(compose + ["port", "web", "8080"])
        api = "http://" + run(compose + ["port", "vektor", "8787"])
        assert request(base, "/").status == 200
        assert request(api, "/").status == 404, "Split API must not serve embedded frontend"
        assert request(base, "/api/settings").status == 401
        source = Path(__file__).with_name("open-workspace.mjs").read_text()
        link = subprocess.run(compose + ["exec", "-T", "vektor", "node", "--input-type=module"], input=source, text=True, capture_output=True, check=True, timeout=20).stdout
        code = link.split("#setup=")[1]
        signed = request(base, "/auth/session", {"code": code}, {"Origin": base})
        assert signed.status == 200
        cookie = signed.headers["Set-Cookie"].split(";")[0]
        assert "HttpOnly" in signed.headers["Set-Cookie"]
        assert request(base, "/auth/session", {"code": code}, {"Origin": base}).status == 401
        assert request(base, "/api/settings", headers={"Cookie": cookie}).status == 200
        assert request(base, "/api/settings", headers={"Cookie": cookie, "Origin": "https://evil.example"}).status == 401
        stream = request(base, "/api/dev/stream", headers={"Cookie": cookie})
        assert stream.status == 200 and "text/event-stream" in stream.headers["Content-Type"]
        assert "run.completed" in stream.read().decode()
        # Force a new API container. The web proxy must discover it without restarting.
        web = run(compose + ["ps", "-q", "web"])
        run(compose + ["up", "-d", "--force-recreate", "--no-deps", "--wait", "--wait-timeout", "120", "vektor"])
        for _ in range(25):
            try:
                if request(base, "/api/session", headers={"Cookie": cookie}).status == 200:
                    break
            except (urllib.error.URLError, TimeoutError, ConnectionResetError):
                pass
            time.sleep(1)
        else:
            raise AssertionError("Web proxy did not reconnect to replaced API")
        assert run(compose + ["ps", "-q", "web"]) == web
        print("Split Docker: independent assets/API, automatic sign-in, cookie protection, SSE, API replacement and session persistence passed.")
    finally:
        run(compose + ["down", "-v", "--remove-orphans"])
