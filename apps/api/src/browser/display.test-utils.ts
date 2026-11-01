import { spawn } from "node:child_process";

export async function testDisplay() {
  const child = spawn(
    "Xvfb",
    ["-displayfd", "3", "-screen", "0", "1024x768x24", "-nolisten", "tcp"],
    { stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  let timer: NodeJS.Timeout | undefined;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await done;
  };
  try {
    const display = await new Promise<string>((resolve, reject) => {
      let output = "";
      timer = setTimeout(() => reject(new Error("Virtual display startup timed out.")), 5000);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Virtual display exited before startup.")));
      child.stdio[3]!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("\n")) resolve(`:${Number(output.trim())}`);
      });
    });
    return { display, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
