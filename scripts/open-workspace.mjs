// Executed inside the API container by the installer. Output is a short-lived link,
// never the persistent API credential. The URL fragment is not sent in HTTP requests.
import process from "node:process";
const { fetch } = globalThis;
import { readFileSync } from "node:fs";
const token =
  process.env.VEKTOR_ACCESS_TOKEN ||
  readFileSync(`${process.env.VEKTOR_DATA_DIR || "/data"}/access-token`, "utf8").trim();
const response = await fetch("http://127.0.0.1:8787/api/session-link", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) throw new Error("API sign-in is not ready. Retry opening the workspace.");
const { code } = await response.json();
if (typeof code !== "string" || !/^[\w-]{43}$/.test(code))
  throw new Error("Invalid sign-in response.");
process.stdout.write(`http://127.0.0.1:8788/?signin=1#setup=${code}`);
