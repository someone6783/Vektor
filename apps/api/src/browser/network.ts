import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import type { BrowserPermissions } from "@vektor/shared";
import { RuntimeError } from "../runtime/terminal.js";

type Address = { address: string; family: number };
export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.kind() === "ipv6" && !parsed.match(ipaddr.parse("2000::"), 3)) return false;
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
export function browserUrl(value: string, permissions: BrowserPermissions): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeError("Invalid browser URL.", 403);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    ![...permissions.allowedOrigins, ...permissions.localOrigins].includes(url.origin)
  )
    throw new RuntimeError("Browser URL is outside this profile's exact allowed origins.", 403);
  return url;
}
export class BrowserNetwork {
  constructor(
    readonly options: {
      permissions: () => BrowserPermissions;
      signal: AbortSignal;
      redact: (value: string) => string;
      protectedPort?: number;
      resolve?: (host: string) => Promise<Address[]>;
    },
  ) {}
  async address(url: URL): Promise<Address> {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const permitted = browserUrl(url.href, this.options.permissions());
    const local = this.options.permissions().localOrigins.includes(permitted.origin);
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await Promise.race([
          (this.options.resolve ?? ((hostname) => lookup(hostname, { all: true, verbatim: true })))(
            host,
          ),
          new Promise<never>((_done, reject) => {
            const timer = setTimeout(
              () => reject(new RuntimeError("Browser DNS lookup timed out.")),
              5000,
            );
            timer.unref();
          }),
        ]);
    if (!addresses.length) throw new RuntimeError("Browser DNS returned no addresses.", 403);
    const loopback = (address: string) => {
      try {
        return ipaddr.process(address).range() === "loopback";
      } catch {
        return false;
      }
    };
    if (
      local &&
      this.options.protectedPort &&
      Number(url.port || (url.protocol === "https:" ? 443 : 80)) === this.options.protectedPort
    )
      throw new RuntimeError("Browser access to the backend listener is blocked.", 403);
    if (addresses.some(({ address }) => (local ? !loopback(address) : !publicAddress(address))))
      throw new RuntimeError(
        "Browser network access to private, loopback, metadata or reserved addresses is blocked.",
        403,
      );
    this.options.signal.throwIfAborted();
    return addresses.find((address) => address.family === 4) ?? addresses[0]!;
  }
  async request(
    value: string,
    method = "GET",
    headers: Record<string, string> = {},
    body?: Buffer,
    limit = 2 * 1024 * 1024,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const url = browserUrl(value, this.options.permissions());
    const outgoing = { ...headers };
    for (const key of Object.keys(outgoing))
      if (
        /^(host|connection|content-length|accept-encoding|proxy-.*|upgrade|authorization)$/i.test(
          key,
        )
      )
        delete outgoing[key];
    outgoing["accept-encoding"] = "identity";
    const raw = `${url.href}\n${JSON.stringify(outgoing)}\n${body?.toString("utf8") ?? ""}`;
    if (this.options.redact(raw) !== raw)
      throw new RuntimeError("Browser requests cannot contain backend credentials.", 403);
    const address = await this.address(url);
    const signal = AbortSignal.any([this.options.signal, AbortSignal.timeout(8000)]);
    return new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method,
          headers: outgoing,
          signal,
          agent: false,
          family: address.family,
          lookup: (_host, _options, done) => done(null, address.address, address.family),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit)
              response.destroy(new RuntimeError("Browser response exceeds its size limit.", 413));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 502,
              headers: safeHeaders(response.headers),
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }
}
function safeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(
        ([name]) =>
          ![
            "connection",
            "transfer-encoding",
            "content-length",
            "alt-svc",
            "upgrade",
            "proxy-authenticate",
          ].includes(name),
      )
      .map(([name, value]) => [
        name,
        Array.isArray(value) ? value.join(name === "set-cookie" ? "\n" : ", ") : (value ?? ""),
      ]),
  );
}
