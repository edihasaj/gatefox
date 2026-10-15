import { createServer } from "node:http";
import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from "node:crypto";
import { readFile, open, unlink, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { writePrivateJson } from "../config.js";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const requiredScopes = ["resource.invoke", "chatgpt.tokens.use.direct"];
export interface ChatGPTCredentials {
  client_id: string;
  subject: string;
  email?: string;
  ext_agent_host_id: string;
  access_token: string;
  refresh_token?: string;
  id_token: string;
  scopes: string[];
  expires_at: number;
  earliest_refresh_at?: number;
}
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  earliest_refresh_at?: number;
}

/** The stored login cannot work again without the user: missing, rejected or lacking scopes. Other failures are temporary. */
export class ChatGPTLoginRequired extends Error {}

async function json<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
  // 400/401/403 mean the grant was rejected (revoked or reused); 429 and 5xx clear by themselves.
  if (!response.ok) throw new ([400, 401, 403].includes(response.status) ? ChatGPTLoginRequired : Error)(`OpenAI authentication returned HTTP ${response.status}; sign in again if access was revoked`);
  return await response.json() as T;
}

export async function readCredentials(path: string): Promise<ChatGPTCredentials | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as ChatGPTCredentials; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new ChatGPTLoginRequired("Credential file is unreadable or invalid"); }
}

/** Whether a ChatGPT plan login with the scopes inference needs is stored. It never refreshes, uses the network or writes. */
export async function hasPlanLogin(path: string): Promise<boolean> {
  try { const credentials = await readCredentials(path); return !!credentials && requiredScopes.every(scope => credentials.scopes?.includes(scope)); }
  catch { return false; }
}

/** Verify OIDC identity before accepting any account's credentials. */
export async function validateIdToken(token: string, clientId: string, nonce: string,
  keys?: Array<JsonWebKey & { kid?: string }>, now = Date.now()): Promise<{ subject: string; email?: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token");
  const decode = <T>(part: string): T => {
    try { return JSON.parse(Buffer.from(part, "base64url").toString()) as T; }
    catch { throw new Error("Invalid ID token encoding"); }
  };
  const header = decode<{ alg: string; kid: string }>(parts[0]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported ID token signature");
  const jwks = keys || (await json<{ keys: Array<JsonWebKey & { kid?: string }> }>(`${issuer}/.well-known/jwks.json`)).keys;
  const key = jwks.find(key => key.kid === header.kid);
  if (!key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"))) throw new Error("ID token signature did not validate");
  const claims = decode<{ iss: string; aud: string | string[]; exp: number; nbf?: number; nonce: string; sub: string; email?: string }>(parts[1]);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audience.includes(clientId) || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now || (claims.nbf && claims.nbf * 1000 > now + 60000) || claims.nonce !== nonce || !claims.sub) throw new Error("ID token identity, audience, expiry, or nonce did not validate");
  return { subject: claims.sub, ...(claims.email ? { email: claims.email } : {}) };
}

function grantedScopes(token: TokenResponse): string[] {
  const scopes = typeof token.scope === "string" ? token.scope.split(/\s+/) : [];
  if (token.token_type?.toLowerCase() !== "bearer" || !token.access_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || requiredScopes.some(scope => !scopes.includes(scope))) throw new Error("ChatGPT plan permission was not granted; enable plan usage during sign-in");
  return scopes;
}

/** Separate registration for this tool; never imports Codex's credentials. */
export async function signIn(path: string, agentName: string, onAuthorize: (url: string) => void | Promise<void>, signal?: AbortSignal, expectedEmail?: string): Promise<void> {
  const email = expectedEmail?.trim().toLowerCase();
  if (expectedEmail !== undefined && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("Requested account email is invalid");
  const prior = await readCredentials(path);
  const hostPath = resolve(dirname(path), "host.json");
  let host: { id: string };
  try { host = JSON.parse(await readFile(hostPath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Host identity file is invalid");
    host = { id: `urn:uuid:${randomUUID()}` }; await writePrivateJson(hostPath, host);
  }
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  let resolveCallback!: (value: { code: string; clientId: string }) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  // The listener can reject while the opener is still running.
  void callback.catch(() => {});
  let accepted = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
    if (accepted || url.searchParams.get("state") !== state) { res.writeHead(400).end("Invalid sign-in state"); return; }
    if (url.searchParams.has("error")) {
      accepted = true; res.writeHead(400).end("Sign-in was not authorized"); rejectCallback(new Error("Sign-in was not authorized")); return;
    }
    const clientId = url.searchParams.get("client_id") || prior?.client_id;
    const code = url.searchParams.get("code");
    if (!code || !clientId || clientId === "dynamic_agent_client" || (prior && clientId !== prior.client_id)) {
      res.writeHead(400).end("Incomplete or mismatched registration"); return;
    }
    accepted = true;
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Authorization received. Return to the terminal to see whether sign-in succeeded.");
    resolveCallback({ code, clientId });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  const redirect = `http://127.0.0.1:${port}/auth/callback`;
  const url = new URL(`${issuer}/api/accounts/authorize`);
  const params = { client_id: prior?.client_id || "dynamic_agent_client", ext_agent_host_id: host.id,
    response_type: "code", redirect_uri: redirect, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource, state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    ...(!prior ? { agent_name_hint: agentName } : {}),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const timeout = setTimeout(() => rejectCallback(new Error("Sign-in timed out; run login again")), 15 * 60000);
  const abort = () => rejectCallback(new Error("Sign-in cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new Error("Sign-in cancelled");
    await onAuthorize(url.toString());
    const authorization = await callback;
    const token = await json<TokenResponse>(`${issuer}/api/accounts/oauth/token`, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: authorization.clientId, code: authorization.code, code_verifier: verifier, redirect_uri: redirect, resource }),
    });
    const identity = await validateIdToken(token.id_token, authorization.clientId, nonce);
    if (email && identity.email?.trim().toLowerCase() !== email) throw new Error("Sign-in returned a different account; choose the requested account and sign in again");
    if (prior && identity.subject !== prior.subject) throw new Error("Sign-in returned a different account; add it as a separate provider instead");
    const scopes = grantedScopes(token);
    await writePrivateJson(path, { ...identity, client_id: authorization.clientId, ext_agent_host_id: host.id,
      access_token: token.access_token, refresh_token: token.refresh_token, id_token: token.id_token,
      scopes, expires_at: Date.now() + token.expires_in * 1000, earliest_refresh_at: token.earliest_refresh_at,
    } satisfies ChatGPTCredentials);
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const refreshing = new Map<string, Promise<string>>();
export async function accessToken(path: string): Promise<string> {
  const credentials = await readCredentials(path);
  if (!credentials || requiredScopes.some(scope => !credentials.scopes?.includes(scope))) throw new ChatGPTLoginRequired("ChatGPT provider requires login");
  if (credentials.expires_at > Date.now() + 120000 || (credentials.earliest_refresh_at && credentials.earliest_refresh_at * 1000 > Date.now() && credentials.expires_at > Date.now())) return credentials.access_token;
  const existing = refreshing.get(path); if (existing) return existing;
  const operation = refresh(path);
  refreshing.set(path, operation);
  try { return await operation; } finally { refreshing.delete(path); }
}

async function refresh(path: string): Promise<string> {
  const lock = `${path}.refresh-lock`; const deadline = Date.now() + 20000;
  let file;
  while (!file) {
    try { file = await open(lock, "wx", 0o600); await file.writeFile(String(process.pid)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(lock, "utf8").catch(() => "0"));
      if (pid > 0) {
        try { process.kill(pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { await unlink(lock).catch(() => {}); continue; } }
      }
      if (!pid && await stat(lock).then(info => Date.now() - info.mtimeMs > 20000, () => false)) { await unlink(lock).catch(() => {}); continue; }
      if (Date.now() > deadline) throw new Error("Credential refresh is busy; retry shortly");
      await delay(100);
    }
  }
  try {
    const credentials = await readCredentials(path);
    if (!credentials) throw new ChatGPTLoginRequired("ChatGPT provider requires login");
    if (credentials.expires_at > Date.now() + 120000) return credentials.access_token;
    if (!credentials.refresh_token) throw new ChatGPTLoginRequired("ChatGPT login expired; sign in again");
    const token = await json<TokenResponse>(`${issuer}/api/accounts/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: credentials.client_id, refresh_token: credentials.refresh_token, resource }),
    });
    const scopes = grantedScopes(token);
    if (!token.refresh_token) throw new Error("OpenAI did not return a replacement refresh token");
    await writePrivateJson(path, { ...credentials, access_token: token.access_token, refresh_token: token.refresh_token,
      id_token: token.id_token || credentials.id_token, scopes, expires_at: Date.now() + token.expires_in * 1000, earliest_refresh_at: token.earliest_refresh_at });
    return token.access_token;
  } finally { await file.close(); await unlink(lock); }
}
