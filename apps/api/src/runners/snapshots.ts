import { RuntimeError } from "../runtime/terminal.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { encryptSecret, decryptSecret } from "../secrets.js";

// Only private harness state is checkpointed, after the process has exited.
// Archive readers reject links, traversal, special files and oversized content.
const script = `
import os,sys,tarfile,io
root=sys.argv[2]
limit=33554432
if sys.argv[1]=='save':
    result=io.BytesIO(); total=0; count=0
    with tarfile.open(fileobj=result,mode='w:gz',dereference=False) as archive:
        for directory,dirs,files in os.walk(root,followlinks=False):
            dirs[:]=[name for name in dirs if not os.path.islink(os.path.join(directory,name))]
            for name in files:
                path=os.path.join(directory,name)
                if os.path.islink(path) or not os.path.isfile(path): continue
                size=os.stat(path).st_size; total+=size; count+=1
                if total>limit or count>2000: raise ValueError('checkpoint limit')
                archive.add(path,arcname=os.path.relpath(path,root),recursive=False)
    sys.stdout.buffer.write(result.getvalue())
else:
    raw=sys.stdin.buffer.read(limit+1)
    if len(raw)>limit: raise ValueError('checkpoint limit')
    total=0; count=0
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
        for member in archive:
            count+=1; total+=member.size
            parts=member.name.split('/')
            if count>2000 or total>limit or member.name.startswith('/') or '..' in parts or not member.isfile(): raise ValueError('invalid checkpoint')
            target=os.path.join(root,*parts)
            os.makedirs(os.path.dirname(target),mode=0o700,exist_ok=True)
            with open(target,'xb') as output: output.write(archive.extractfile(member).read())
            os.chmod(target,0o600)
`;
async function archive(mode: "save" | "load", directory: string, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/prlimit",
      ["--as=1073741824", "--cpu=10", "--", "/usr/bin/python3", "-c", script, mode, directory],
      { shell: false, env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const chunks: Buffer[] = [];
    let length = 0;
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 32 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || length > 32 * 1024 * 1024)
        reject(new Error("Harness checkpoint exceeded its limits or is invalid."));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}
export class HarnessSnapshots {
  private readonly directory: string;
  constructor(
    dataDir: string,
    private readonly key: Buffer,
  ) {
    this.directory = join(dataDir, "runners", "checkpoints");
  }
  private path(runId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid checkpoint id");
    return join(this.directory, `${runId}.enc`);
  }
  async home(resumeFromRunId?: string): Promise<string> {
    const home = await mkdtemp("/dev/shm/vektor-session-");
    try {
      if (resumeFromRunId) {
        const file = this.path(resumeFromRunId);
        if ((await stat(file)).size > 64 * 1024 * 1024)
          throw new Error("Oversized harness checkpoint");
        const plain = decryptSecret(await readFile(file, "utf8"), this.key);
        await archive("load", home, Buffer.from(plain, "base64"));
      }
      await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
      return home;
    } catch (error) {
      await rm(home, { recursive: true, force: true });
      if (resumeFromRunId)
        throw new RuntimeError(
          "The saved agent checkpoint is unavailable, expired or invalid. Start a fresh session.",
          409,
        );
      throw error;
    }
  }
  async save(runId: string, home: string): Promise<void> {
    const raw = await archive("save", home);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(runId);
    const temporary = `${path}.${randomUUID()}`;
    try {
      await writeFile(temporary, encryptSecret(raw.toString("base64"), this.key), { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    const files = await Promise.all(
      (await readdir(this.directory))
        .filter((name) => /^[a-f0-9-]{36}\.enc$/.test(name))
        .map(async (name) => ({
          name,
          modified: (await stat(join(this.directory, name))).mtimeMs,
        })),
    );
    files.sort((a, b) => b.modified - a.modified);
    for (const file of files.slice(20)) await rm(join(this.directory, file.name), { force: true });
  }
  async remove(runId: string): Promise<void> {
    await rm(this.path(runId), { force: true });
  }
}
