import { createInterface } from "node:readline";

/**
 * The loopback callback a pasted line names, or undefined. Only `http://127.0.0.1:PORT/auth/callback` (or `localhost`) on the
 * port of the sign-in's own redirect is accepted, so a paste can only ever reach the listener this sign-in opened.
 */
export function pastedCallback(line: string, authorizeUrl: string): string | undefined {
  let redirect: URL, pasted: URL;
  try { redirect = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri") || ""); pasted = new URL(line.trim().replace(/\\([&_=?])/g, "$1")); } catch { return; }
  if (pasted.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(pasted.hostname) || pasted.port !== redirect.port || pasted.pathname !== redirect.pathname) return;
  if (!pasted.searchParams.get("code") && !pasted.searchParams.get("error")) return;
  return `http://127.0.0.1:${redirect.port}${pasted.pathname}${pasted.search}`;
}

/** Reads pasted lines and delivers the first valid callback to the local listener. Returns a function that stops reading. */
export function forwardPastedCallback(authorizeUrl: string, input: NodeJS.ReadableStream, deliver: (url: string) => Promise<unknown> = url => fetch(url, { signal: AbortSignal.timeout(15000) })): () => void {
  const lines = createInterface({ input }); let done = false;
  lines.on("line", line => {
    if (done) return; const target = pastedCallback(line, authorizeUrl);
    if (!target) { if (line.trim()) process.stderr.write("That is not this sign-in's http://127.0.0.1 callback address; paste the full address from the browser's address bar.\n"); return; }
    done = true; lines.close(); void deliver(target).catch(() => { process.stderr.write("The pasted address could not be delivered; it may have expired. Start the sign-in again.\n"); });
  });
  return () => { done = true; lines.close(); if ("pause" in input && typeof input.pause === "function") input.pause(); };
}
