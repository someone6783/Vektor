import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock
import uuid

spec = importlib.util.spec_from_file_location("updater", Path(__file__).with_name("docker-updater.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdaterTests(unittest.TestCase):
    def test_request_validation(self):
        self.assertEqual(updater.validate_request({"id": str(uuid.uuid4()), "version": "1.2.3"})["version"], "1.2.3")
        for value in ["latest", "1.2.3; touch bad", "01.2.3", "1.2.3-beta.1", "v1.2.3"]:
            with self.assertRaises(ValueError):
                updater.validate_request({"id": str(uuid.uuid4()), "version": value})

    def test_status_write_does_not_follow_a_symlink(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "secret"
            secret.write_text("preserve")
            (root / "status.json").symlink_to(secret)
            (root / "status.tmp").symlink_to(secret)
            updater.atomic_json(root / "status.json", {"state": "idle"})
            self.assertEqual(secret.read_text(), "preserve")
            self.assertFalse((root / "status.json").is_symlink())

    def test_restart_reports_interruption_without_replaying_request(self):
        with TemporaryDirectory() as tmp, patch.object(updater.os, "chown"):
            queue = Path(tmp) / "queue"
            queue.mkdir()
            (queue / "status.json").write_text(json.dumps({"state": "installing"}))
            (queue / "request.json").write_text(json.dumps({"id": str(uuid.uuid4()), "version": "0.2.0"}))
            value = updater.Updater(SimpleNamespace(queue=str(queue), backups=tmp + "/backups", compose=tmp + "/compose.yaml", project="existing", service="vektor", group=os.getgid()))
            self.assertEqual(value.state["state"], "failed")
            self.assertFalse((queue / "request.json").exists())
            self.assertIsNone(value.worker)
            value.lock.close()

    def simulate(self, failure=None, split=False):
        with TemporaryDirectory() as tmp, patch.object(updater.os, "chown"):
            args = SimpleNamespace(queue=tmp + "/queue", backups=tmp + "/backups", compose=tmp + "/compose.yaml", project="existing", service="vektor", group=os.getgid())
            value = updater.Updater(args)
            calls = []
            if split:
                (Path(tmp) / "release.env").write_text("VEKTOR_IMAGE=old\nVEKTOR_WEB_IMAGE=old\n")

            def run(command, **kwargs):
                calls.append((command, kwargs))
                if "inspect" in command and "image" not in command:
                    return json.dumps([{"Image": "old-image", "Config": {"Labels": {"org.opencontainers.image.version": "0.1.0"}}}])
                if "config" in command:
                    services = {"vektor": {"image": "ghcr.io/someone6783/vektor:0.2.0"}}
                    if split:
                        services["web"] = {"image": updater.IMAGE + "-web:0.2.0"}
                    return json.dumps({"services": services})
                if "image" in command:
                    is_web = command[-1].startswith(updater.IMAGE + "-web:")
                    version = "wrong" if is_web and failure == "web-version" else "0.2.0"
                    image = updater.IMAGE + ("-web" if is_web else "")
                    return json.dumps([{"Config": {"Labels": {"org.opencontainers.image.version": version}}, "RepoDigests": [image + "@sha256:pinned"]}])
                if "cp" in command and failure == "backup":
                    raise RuntimeError("backup failed")
                if "up" in command and failure == "install":
                    raise RuntimeError("installation failed")
                if "exec" in command:
                    return json.dumps({"version": "0.2.0"})
                return "container" if "ps" in command else ""

            response = MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps({"tag_name": "v0.2.0", "draft": False, "prerelease": False}).encode()
            with patch.object(updater, "run", side_effect=run), patch.object(updater.urllib.request, "urlopen", return_value=response):
                value.install({"id": str(uuid.uuid4()), "version": "0.2.0"})
            value.lock.close()
            return value.state, calls

    def test_backup_precedes_replacement_and_image_is_pinned(self):
        state, calls = self.simulate()
        self.assertEqual(state["state"], "complete")
        commands = [command for command, _ in calls]
        self.assertLess(next(i for i, c in enumerate(commands) if "cp" in c), next(i for i, c in enumerate(commands) if "up" in c))
        install = next(kwargs for command, kwargs in calls if "up" in command)
        self.assertEqual(install["env"]["VEKTOR_IMAGE"], updater.IMAGE + "@sha256:pinned")

    def test_split_updates_pin_and_replace_both_services(self):
        state, calls = self.simulate(split=True)
        self.assertEqual(state["state"], "complete")
        install = next((command, kwargs) for command, kwargs in calls if "up" in command)
        self.assertEqual(install[0][-2:], ["vektor", "web"])
        self.assertEqual(install[1]["env"]["VEKTOR_WEB_IMAGE"], updater.IMAGE + "-web@sha256:pinned")

    def test_mismatched_web_image_aborts_before_stopping_backend(self):
        state, calls = self.simulate("web-version", split=True)
        self.assertEqual(state["state"], "failed")
        self.assertFalse(any("stop" in command for command, _ in calls))
        self.assertFalse(any("cp" in command for command, _ in calls))

    def test_backup_failure_restarts_old_container_without_replacement(self):
        state, calls = self.simulate("backup")
        self.assertEqual(state["state"], "failed")
        self.assertTrue(any("start" in command for command, _ in calls))
        self.assertFalse(any("up" in command for command, _ in calls))

    def test_install_failure_stops_backend_without_automatic_downgrade(self):
        state, calls = self.simulate("install")
        self.assertEqual(state["state"], "failed")
        self.assertFalse(any("start" in command for command, _ in calls))
        self.assertEqual(sum("stop" in command for command, _ in calls), 2)


if __name__ == "__main__":
    unittest.main()
