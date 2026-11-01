import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-docker-helper.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_snapshot_preserves_project_volumes_ports_and_environment(self):
        original = {"name": "existing", "services": {"vektor": {
            "image": "ghcr.io/someone6783/vektor:0.1.0",
            "environment": {"VEKTOR_GITHUB_TOKEN": "fixture-private-token"},
            "ports": [{"target": 8787, "published": "8787", "host_ip": "127.0.0.1"}],
            "volumes": [{"type": "volume", "source": "data", "target": "/data"}]
        }}, "volumes": {"data": {"name": "existing_vektor-data"}}}
        managed = installer.managed_config(original, "vektor", Path("queue"))
        self.assertEqual(managed["name"], "existing")
        self.assertEqual(managed["volumes"], original["volumes"])
        self.assertEqual(managed["services"]["vektor"]["ports"], original["services"]["vektor"]["ports"])
        self.assertEqual(managed["services"]["vektor"]["environment"]["VEKTOR_GITHUB_TOKEN"], "fixture-private-token")
        self.assertEqual(managed["services"]["vektor"]["volumes"][0], original["services"]["vektor"]["volumes"][0])
        self.assertNotIn("VEKTOR_UPDATE_DIR", original["services"]["vektor"]["environment"])
        self.assertEqual(len(installer.managed_config(managed, "vektor", Path("queue2"))["services"]["vektor"]["volumes"]), 2)

    def test_rejects_source_builds_and_other_images(self):
        for service in [{"build": ".", "image": "vektor:local"}, {"image": "other/image:latest"}]:
            with self.assertRaises(ValueError):
                installer.managed_config({"services": {"vektor": service}}, "vektor", Path("queue"))

    @unittest.skipIf(installer.os.name == "nt", "systemd is Linux only")
    def test_service_quotes_paths_and_rejects_expansion_characters(self):
        unit = installer.systemd_unit(Path("/var/lib/Vektor updates"), "existing", "vektor")
        self.assertIn('"/var/lib/Vektor updates/compose.json"', unit)
        self.assertIn("Restart=on-failure", unit)
        for path in ["/bad%path", "/bad$path", "/bad\npath"]:
            with self.assertRaises(ValueError):
                installer.systemd_unit(Path(path), "existing", "vektor")


if __name__ == "__main__":
    unittest.main()
