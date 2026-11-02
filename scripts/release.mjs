import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { prerelease } from "semver";
import { projectRoot, syncVersion } from "./version.mjs";

export function releaseTags(version, image) {
  return prerelease(version)
    ? [`${image}:${version}`]
    : [
        `${image}:${version}`,
        `${image}:${version.split(".").slice(0, 2).join(".")}`,
        `${image}:latest`,
      ];
}
export function validateTag(tag, version) {
  if (tag !== `v${version}`)
    throw new Error(`Release tag must be v${version}, received ${JSON.stringify(tag)}.`);
}
export function validate(tag, root = projectRoot) {
  const info = syncVersion(true, root);
  validateTag(tag, info.version);
  if (
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_REPOSITORY.toLowerCase() !== info.repository.toLowerCase()
  )
    throw new Error("Release repository differs from root metadata.");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const revision = git("rev-parse", "HEAD");
  if (git("rev-list", "-n", "1", tag) !== revision)
    throw new Error("Release tag must point at the checked-out commit.");
  if (git("status", "--porcelain", "--untracked-files=no"))
    throw new Error("Release checkout has uncommitted tracked changes.");
  return {
    ...info,
    tag,
    revision,
    date: new Date().toISOString(),
    prerelease: prerelease(info.version) !== null,
    tags: releaseTags(info.version, info.image),
  };
}

export function checksums(directory) {
  const names = readdirSync(directory)
    .filter((name) => name !== "SHA256SUMS")
    .sort();
  const output =
    names
      .map(
        (name) =>
          `${createHash("sha256")
            .update(readFileSync(resolve(directory, name)))
            .digest("hex")}  ${name}`,
      )
      .join("\n") + "\n";
  writeFileSync(resolve(directory, "SHA256SUMS"), output);
}

function pack() {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("The API archive is built on Linux x64 with Node 22.");
  if (Number(process.versions.node.split(".")[0]) !== 22)
    throw new Error("The API archive requires Node 22.");
  const info = syncVersion(true);
  const directory = resolve(projectRoot, "release-artifacts");
  const stage = resolve(directory, ".stage");
  mkdirSync(directory, { recursive: true });
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  const run = (command, args) =>
    execFileSync(command, args, { cwd: projectRoot, stdio: "inherit" });
  try {
    run("pnpm", [
      "--config.inject-workspace-packages=true",
      "--filter",
      "@vektor/api",
      "deploy",
      "--prod",
      resolve(stage, "api"),
    ]);
    cpSync(resolve(projectRoot, "apps/web/dist"), resolve(stage, "web/dist"), { recursive: true });
    cpSync(
      resolve(projectRoot, "scripts/install-docker-helper.py"),
      resolve(directory, "install-docker-helper.py"),
    );
    cpSync(
      resolve(projectRoot, "scripts/docker-updater.py"),
      resolve(directory, "docker-updater.py"),
    );
    cpSync(
      resolve(projectRoot, "compose.updates.yaml"),
      resolve(directory, "compose.updates.yaml"),
    );
    for (const name of ["install.sh", "install.ps1", "open-workspace.mjs"]) {
      cpSync(resolve(projectRoot, "scripts", name), resolve(directory, name));
    }
    cpSync(resolve(projectRoot, "docs/INSTALLING.md"), resolve(directory, "INSTALLING.md"));
    cpSync(resolve(projectRoot, "docs/UPDATES.md"), resolve(directory, "UPDATES.md"));
    cpSync(resolve(projectRoot, "docs/OPERATIONS.md"), resolve(stage, "OPERATIONS.md"));
    cpSync(resolve(projectRoot, "docs/RELEASING.md"), resolve(stage, "RELEASING.md"));
    cpSync(resolve(projectRoot, "docs/BROWSER.md"), resolve(stage, "BROWSER.md"));
    const epoch = execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    const archive = (name, source, paths) =>
      run("tar", [
        "--sort=name",
        `--mtime=@${epoch}`,
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        resolve(directory, name),
        "-C",
        source,
        ...paths,
      ]);
    archive(`vektor-api-${info.version}-linux-x64-node22.tar.gz`, stage, [
      "api",
      "web",
      "OPERATIONS.md",
      "RELEASING.md",
      "BROWSER.md",
    ]);
    archive(`vektor-web-${info.version}.tar.gz`, resolve(projectRoot, "apps/web/dist"), ["."]);
    cpSync(resolve(projectRoot, "compose.release.yaml"), resolve(directory, "compose.yaml"));
    writeFileSync(
      resolve(directory, "release.json"),
      JSON.stringify(
        {
          ...info,
          revision: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: projectRoot,
            encoding: "utf8",
          }).trim(),
          apiPlatform: "linux-x64-node22",
          webImage: `${info.image}-web`,
          desktopIncludes: ["node22", "api", "chromium"],
          imagePlatforms: ["linux/amd64", "linux/arm64"],
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  checksums(directory);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "pack") pack();
  else if (command === "checksums") checksums(resolve(process.argv[3] ?? "release-artifacts"));
  else if (command === "validate") {
    const info = validate(process.argv[3] ?? process.env.RELEASE_TAG);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${info.version}\nimage=${info.image}\nrevision=${info.revision}\ndate=${info.date}\nprerelease=${info.prerelease}\ntags<<VEKTOR_TAGS\n${info.tags.join("\n")}\nVEKTOR_TAGS\nweb_tags<<VEKTOR_WEB_TAGS\n${releaseTags(info.version, info.image + "-web").join("\n")}\nVEKTOR_WEB_TAGS\n`,
      );
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
  } else throw new Error("Usage: release.mjs validate TAG | pack | checksums DIRECTORY");
}
