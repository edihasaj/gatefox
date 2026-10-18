import { createServer } from "node:net";

async function bind(port: number): Promise<number | undefined> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    const address = server.address();
    return typeof address === "object" && address ? address.port : undefined;
  } catch { return undefined; }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

/** Reserves only long enough to choose a currently available loopback listener; the daemon starts after commit. */
export async function chooseLoopbackPort(): Promise<number> {
  return await bind(3457) || await bind(0) || (() => { throw new Error("No loopback port is available"); })();
}
