"""Exercise the Linux installer without downloads, Docker access or installing software."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parent.parent

@unittest.skipUnless(sys.platform.startswith("linux"), "Linux installer flow")
class InstallerTests(unittest.TestCase):
    def fixture(self, root):
        assets = root / "assets"
        assets.mkdir()
        for name, source in [("compose.yaml", ROOT / "compose.release.yaml"), ("open-workspace.mjs", ROOT / "scripts/open-workspace.mjs")]:
            (assets / name).write_bytes(source.read_bytes())
        (assets / "SHA256SUMS").write_text("".join(hashlib.sha256((assets / name).read_bytes()).hexdigest() + "  " + name + "\n" for name in ["compose.yaml", "open-workspace.mjs"]))
        binaries = root / "bin"
        binaries.mkdir()
        (binaries / "curl").write_text("""#!/usr/bin/env python3
import os,pathlib,shutil,sys
args=sys.argv[1:]; target=args[args.index('-o')+1]
url=args[args.index('-o')-1]
shutil.copyfile(pathlib.Path(os.environ['FIXTURE_ASSETS'])/url.rsplit('/',1)[1],target)
""")
        (binaries / "docker").write_text("""#!/usr/bin/env python3
import json,os,pathlib,sys
with open(os.environ['FIXTURE_COMMANDS'],'a') as output: output.write(json.dumps(sys.argv[1:])+'\\n')
if 'exec' in sys.argv:
    sys.stdin.read()
    print('http://127.0.0.1:8788/?signin=1#setup='+'A'*43,end='')
""")
        for path in binaries.iterdir(): path.chmod(0o755)
        return {**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"], "FIXTURE_ASSETS": str(assets), "FIXTURE_COMMANDS": str(root / "commands"), "DISPLAY": "", "WAYLAND_DISPLAY": ""}

    def test_install_and_reopen_preserve_project_and_user_configuration(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = self.fixture(root)
            project = root / "existing project with spaces"
            project.mkdir()
            (project / "compose.yaml").write_text("existing configuration\n")
            (project / ".env").write_text("COMPOSE_PROJECT_NAME=existing\n")
            command = ["bash", str(ROOT / "scripts/install.sh"), "--directory", str(project)]
            installed = subprocess.run(command + ["--docker", "--version", "0.1.0"], env=env, text=True, capture_output=True)
            self.assertEqual(installed.returncode, 0, installed.stderr)
            self.assertEqual((project / "compose.yaml").read_text(), "existing configuration\n")
            self.assertTrue((project / "compose.release.new.yaml").exists())
            pins = (project / "release.env").read_text()
            self.assertIn("VEKTOR_IMAGE=ghcr.io/someone6783/vektor:0.1.0", pins)
            self.assertIn("VEKTOR_WEB_IMAGE=ghcr.io/someone6783/vektor-web:0.1.0", pins)
            reopened = subprocess.run(command + ["--open"], env=env, text=True, capture_output=True)
            self.assertEqual(reopened.returncode, 0, reopened.stderr)
            calls = (root / "commands").read_text()
            self.assertIn('"--env-file", ".env", "--env-file", "release.env"', calls)
            self.assertEqual(calls.count('"pull"'), 1)
            self.assertEqual(calls.count('"up"'), 1)

    def test_tampered_release_asset_stops_before_any_container_changes(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = self.fixture(root)
            (root / "assets/compose.yaml").write_text("tampered")
            result = subprocess.run(["bash", str(ROOT / "scripts/install.sh"), "--docker", "--version", "0.1.0", "--directory", str(root / "project")], env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("checksum verification failed", result.stderr)
            self.assertNotIn('"pull"', (root / "commands").read_text())
            self.assertNotIn('"up"', (root / "commands").read_text())

if __name__ == "__main__":
    unittest.main()
