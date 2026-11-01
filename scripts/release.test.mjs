import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { metadata, projectRoot, syncVersion } from "./version.mjs";
import { releaseTags, validateTag, validate, checksums } from "./release.mjs";

test("release tags validate against the single version and prereleases cannot move stable aliases", () => {
  assert.deepEqual(releaseTags("1.2.3", "ghcr.io/o/r"), [
    "ghcr.io/o/r:1.2.3",
    "ghcr.io/o/r:1.2",
    "ghcr.io/o/r:latest",
  ]);
  assert.deepEqual(releaseTags("1.3.0-beta.1", "image"), ["image:1.3.0-beta.1"]);
  for (const tag of ["v1.2.4", "1.2.3", "v01.2.3", "v1.2.3\n", "v1.2.3; touch bad"])
    assert.throws(() => validateTag(tag, "1.2.3"));
  assert.doesNotThrow(() => validateTag("v1.2.3", "1.2.3"));
});
test("one root version propagates to workspace packages, API/web constants, Rust, lock and image", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "vektor-version-"));
  try {
    for (const path of [
      "package.json",
      "Dockerfile",
      "compose.release.yaml",
      "apps/api/package.json",
      "apps/web/package.json",
      "packages/db/package.json",
      "packages/shared/package.json",
      "apps/web/src-tauri/Cargo.toml",
      "apps/web/src-tauri/Cargo.lock",
      "apps/web/src-tauri/capabilities/default.json",
    ]) {
      const destination = resolve(directory, path);
      mkdirSync(resolve(destination, ".."), { recursive: true });
      cpSync(resolve(projectRoot, path), destination);
    }
    mkdirSync(resolve(directory, "packages/shared/src"));
    const pkg = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    pkg.version = "1.23.4";
    writeFileSync(resolve(directory, "package.json"), JSON.stringify(pkg));
    assert.throws(() => syncVersion(true, directory), /stale/);
    syncVersion(false, directory);
    syncVersion(true, directory);
    for (const path of [
      "packages/shared/src/build-info.ts",
      "apps/api/package.json",
      "apps/web/package.json",
      "apps/web/src-tauri/Cargo.toml",
      "apps/web/src-tauri/Cargo.lock",
      "Dockerfile",
    ])
      assert.ok(readFileSync(resolve(directory, path), "utf8").includes("1.23.4"), path);
    const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Release fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    git("tag", "v1.23.4");
    assert.equal(validate("v1.23.4", directory).version, "1.23.4");
    writeFileSync(
      resolve(directory, "package.json"),
      readFileSync(resolve(directory, "package.json"), "utf8") + "\n",
    );
    assert.throws(() => validate("v1.23.4", directory), /uncommitted/);
    git("add", ".");
    git(
      "-c",
      "user.name=Release fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "changed",
    );
    assert.throws(() => validate("v1.23.4", directory), /checked-out commit/);
    pkg.version = "01.2.3";
    writeFileSync(resolve(directory, "package.json"), JSON.stringify(pkg));
    assert.throws(() => metadata(directory), /canonical/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("artifact checksums are deterministic and include every payload", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "vektor-checksums-"));
  try {
    writeFileSync(resolve(directory, "payload.tar.gz"), "payload");
    checksums(directory);
    const first = readFileSync(resolve(directory, "SHA256SUMS"), "utf8");
    checksums(directory);
    assert.equal(readFileSync(resolve(directory, "SHA256SUMS"), "utf8"), first);
    assert.match(first, /^[a-f0-9]{64} {2}payload.tar.gz\n$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
