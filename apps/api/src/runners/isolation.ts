import { createServer, connect, type Socket } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { BrowserNetwork } from "../browser/network.js";
import { sandboxBase } from "../computer/sandbox.js";
import { RuntimeError } from "../runtime/terminal.js";

export class InferenceProxy {
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((socket) => this.accept(socket));
  private connections = 0;
  private bytes = 0;
  private readonly abort = () => {
    void this.close();
  };
  constructor(
    private readonly hosts: string[],
    private readonly signal: AbortSignal,
  ) {}
  async listen(path: string): Promise<void> {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.signal.addEventListener("abort", this.abort, { once: true });
    if (this.signal.aborted) await this.close();
  }
  private track(socket: Socket) {
    this.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      this.bytes += chunk.length;
      if (this.bytes > 64 * 1024 * 1024) void this.close();
    });
  }
  private accept(client: Socket) {
    if (++this.connections > 64 || this.sockets.size >= 16 || this.signal.aborted) {
      client.destroy();
      return;
    }
    this.track(client);
    let header = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      if (header.length > 8192) {
        client.destroy();
        return;
      }
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", read);
      client.pause();
      void this.tunnel(client, header.subarray(0, end).toString("ascii"), header.subarray(end + 4));
    };
    client.on("data", read);
  }
  private async tunnel(client: Socket, header: string, extra: Buffer) {
    try {
      const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]\r?$/i.exec(header.split("\r\n")[0]!);
      const host = match?.[1]?.toLowerCase();
      if (!host || !this.hosts.includes(host)) throw new Error("Denied inference destination");
      const address = await this.destination(host);
      this.signal.throwIfAborted();
      if (client.destroyed) return;
      const remote = connect({ host: address.address, family: address.family, port: address.port });
      this.track(remote);
      client.once("close", () => remote.destroy());
      remote.once("close", () => client.destroy());
      remote.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (extra.length) remote.write(extra);
        client.pipe(remote);
        remote.pipe(client);
        client.resume();
      });
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  }
  protected async destination(
    host: string,
  ): Promise<{ address: string; family: number; port: number }> {
    const network = new BrowserNetwork({
      permissions: () => ({
        mode: "observe",
        session: "separate",
        display: "headless",
        allowedOrigins: this.hosts.map((value) => `https://${value}`),
        localOrigins: [],
      }),
      signal: this.signal,
      redact: (value) => value,
    });
    const address = await network.address(new URL(`https://${host}`));
    return { ...address, port: 443 };
  }
  async close(): Promise<void> {
    this.signal.removeEventListener("abort", this.abort);
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// Runs inside the network namespace. The only outbound bridge is a Unix socket
// whose host endpoint validates each CONNECT target and pins public DNS results.
const launcher = `
import json, os, socket, select, threading, subprocess, sys
spec=json.loads(sys.argv[1])
def relay(client):
    remote=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    try:
        remote.connect('/run/inference.sock')
        while True:
            ready,_,_=select.select([client,remote],[],[],30)
            if not ready: break
            for source in ready:
                data=source.recv(65536)
                if not data: return
                (remote if source is client else client).sendall(data)
    except OSError: pass
    finally:
        client.close(); remote.close()
def serve():
    while True:
        client,_=listener.accept()
        threading.Thread(target=relay,args=(client,),daemon=True).start()
listener=socket.socket(); listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
listener.bind(('127.0.0.1',18888)); listener.listen(8)
threading.Thread(target=serve,daemon=True).start()
env={'HOME':'/home/user','CODEX_HOME':'/home/user/.codex','PATH':'/usr/bin:/bin','LANG':'C.UTF-8','TMPDIR':'/tmp'}
with open('/run/credential') as f: env.update(json.load(f))
for key in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']: env[key]='http://127.0.0.1:18888'
env['NO_PROXY']=''; env['no_proxy']=''
sys.exit(subprocess.call(['/run/agent']+spec['args'],env=env,cwd=spec['cwd']))
`;
export async function isolatedRunner(options: {
  command: string;
  args: string[];
  hosts: string[];
  credentials: Record<string, string>;
  signal: AbortSignal;
  home?: string;
  stage?: string;
  stageReadOnly?: boolean;
  workingDirectory?: string;
  brokerSocket?: string;
  proxy?: InferenceProxy;
  caCertificate?: string;
}) {
  if (
    process.platform !== "linux" ||
    !existsSync("/usr/bin/bwrap") ||
    !existsSync("/usr/bin/python3") ||
    !existsSync("/usr/bin/prlimit") ||
    !existsSync("/dev/shm")
  )
    throw new RuntimeError(
      "External runners require Linux, Bubblewrap, Python 3, prlimit and /dev/shm.",
      409,
    );
  options.signal.throwIfAborted();
  const directory = await mkdtemp("/dev/shm/vektor-runner-");
  await chmod(directory, 0o700);
  const proxy = options.proxy ?? new InferenceProxy(options.hosts, options.signal);
  try {
    const socket = join(directory, "proxy.sock");
    const credential = join(directory, "credential");
    await writeFile(
      credential,
      JSON.stringify({
        ...options.credentials,
        ...(options.caCertificate
          ? { SSL_CERT_FILE: "/run/extra-ca.pem", CODEX_CA_CERTIFICATE: "/run/extra-ca.pem" }
          : {}),
      }),
      { mode: 0o600 },
    );
    await proxy.listen(socket);
    const args = [
      ...sandboxBase(),
      "--dir",
      "/home/user/.codex",
      "--dir",
      "/workspace",
      "--ro-bind",
      realpathSync(options.command),
      "/run/agent",
      "--ro-bind",
      socket,
      "/run/inference.sock",
      "--ro-bind",
      credential,
      "/run/credential",
    ];
    if (options.caCertificate) args.push("--ro-bind", options.caCertificate, "/run/extra-ca.pem");
    if (options.stage)
      args.push(options.stageReadOnly ? "--ro-bind" : "--bind", options.stage, "/workspace");
    if (options.brokerSocket) args.push("--ro-bind", options.brokerSocket, "/run/vektor-mcp.sock");
    if (options.home) args.push("--bind", options.home, "/home/user");
    if (existsSync("/etc/ssl/certs")) args.push("--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs");
    args.push(
      "--",
      "/usr/bin/python3",
      "-c",
      launcher,
      JSON.stringify({ args: options.args, cwd: options.workingDirectory ?? "/workspace" }),
    );
    return {
      orphanCleanupPaths: [
        directory,
        ...(options.home ? [options.home] : []),
        ...(options.stage ? [options.stage] : []),
      ],
      command: "/usr/bin/prlimit",
      args: [
        "--as=4294967296",
        "--cpu=120",
        "--nofile=128",
        "--fsize=33554432",
        "--",
        "/usr/bin/bwrap",
        ...args,
      ],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      async close() {
        await proxy.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
