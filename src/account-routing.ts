import type { Message } from "./app-server-connection.js";

/** Pure name, alias, family and route decisions for account engines. No I/O, no timers. */
export const accountIdPattern = /^[a-z][a-z0-9_-]{0,31}$/;
export const accountProviderPattern = /^account_([a-z][a-z0-9_-]{0,31})$/;
export const accountProviderId = (id: string): string => `account_${id}`;
export function accountIdFromProvider(provider: unknown): string | undefined {
  const match = typeof provider === "string" ? accountProviderPattern.exec(provider) : undefined;
  return match ? match[1] : undefined;
}
export const isAccountProvider = (provider: unknown): boolean => accountIdFromProvider(provider) !== undefined;
export const accountAlias = (id: string, upstream: string): string => `${id}/${upstream}`;
export function splitAccountAlias(value: unknown, ids?: Iterable<string>): { id: string; upstream: string } | undefined {
  if (typeof value !== "string") return;
  const slash = value.indexOf("/");
  if (slash < 2) return;
  const id = value.slice(0, slash); const upstream = value.slice(slash + 1);
  if (!upstream || !accountIdPattern.test(id)) return;
  if (ids && ![...ids].some(candidate => candidate === id)) return;
  return { id, upstream };
}

export type AccountStatus = "ready" | "starting" | "idle" | "not_configured" | "not_logged_in" | "identity_mismatch" | "busy_elsewhere" | "failed";
export const startingStatuses: ReadonlySet<AccountStatus> = new Set(["ready", "starting", "idle"]);
export interface AccountRoute { id: string; status: AccountStatus; slugs: ReadonlySet<string> }
export interface RouteContext { gatewayProvider: string; aliases: ReadonlySet<string>; accounts: ReadonlyMap<string, AccountRoute> }

export class AccountRoutingError extends Error { constructor(message: string, readonly code: number) { super(message); } }

/** Fixed, actionable text for a thread that belongs to an account this connection cannot serve. */
export function unavailableMessage(id: string, status: AccountStatus): string {
  if (status === "busy_elsewhere") return `Account ${id} is in use by another connection on this Mac. Close its chat there or wait for its engine to go idle, then retry.`;
  if (status === "identity_mismatch") return `Account ${id}'s saved sign-in no longer matches this Mac. Run gateway account logout ${id} and gateway account login ${id} on this Mac.`;
  if (status === "not_logged_in" || status === "not_configured") return `Account ${id} is not signed in on this Mac. Run gateway account login ${id} on this Mac, then reopen this chat.`;
  return `Account ${id}'s engine is unavailable on this Mac. Retry shortly; if it persists, run gateway account status ${id}.`;
}

/** The upstream slug behind an alias of this account, or a plain slug the account lists. */
export function resolveUpstream(value: unknown, account: AccountRoute, context: RouteContext): string | undefined {
  const alias = splitAccountAlias(value);
  if (!alias) return typeof value === "string" && account.slugs.has(value) ? value : undefined;
  if (alias.id === account.id) return alias.upstream;
  // A shared name (an account whose ID equals a codex-subscription provider) keeps one alias for both routes.
  return context.aliases.has(String(value)) && account.slugs.has(alias.upstream) ? alias.upstream : undefined;
}

/** Upstream slug -> this account's alias; anything the account does not list is left alone. */
export function toAccountAlias(value: unknown, account: AccountRoute): string | undefined {
  if (typeof value !== "string") return;
  const alias = splitAccountAlias(value, [account.id]);
  if (alias) return account.slugs.has(alias.upstream) ? value : undefined;
  return account.slugs.has(value) ? accountAlias(account.id, value) : undefined;
}

/** Request rewrite for a chat running on an account engine: alias to upstream, never the gateway catalog. */
export function toUpstream(params: Message, account: AccountRoute, context: RouteContext): Message {
  const map = (model: unknown) => resolveUpstream(model, account, context);
  const next: Message = { ...params };
  if (typeof params.model === "string") { const model = map(params.model); if (model) next.model = model; }
  const settings = params.collaborationMode && typeof params.collaborationMode === "object" ? (params.collaborationMode as Message).settings as Message | undefined : undefined;
  if (settings && typeof settings.model === "string") {
    const model = map(settings.model);
    next.collaborationMode = { ...(params.collaborationMode as Message), settings: { ...settings, ...(model ? { model } : {}) } };
  }
  if (params.config && typeof params.config === "object") {
    const config = { ...(params.config as Message) };
    if (typeof config.model === "string") { const model = map(config.model); if (model) config.model = model; }
    delete config.model_catalog_json;
    next.config = config;
  }
  return next;
}

/** Result rewrite at the adapter edge: account threads report their alias, never the upstream slug. */
export function presentResult(method: string, result: Message, accounts: ReadonlyMap<string, AccountRoute>): Message {
  if (!["thread/start", "thread/resume", "thread/fork", "thread/read", "thread/list"].includes(method)) return result;
  if (method === "thread/list") {
    if (!Array.isArray(result.data)) return result;
    const source = result.data as unknown[];
    const data = source.map(row => presentThread(row as Message, accounts));
    return data.some((row, index) => row !== source[index]) ? { ...result, data } : result;
  }
  let next: Message | undefined;
  if (result.thread) { const thread = presentThread(result.thread as Message, accounts); if (thread !== result.thread) next = { ...result, thread }; }
  const providerId = accountIdFromProvider((next ?? result).modelProvider);
  const account = providerId ? accounts.get(providerId) : undefined;
  if (account) {
    if (typeof (next ?? result).model === "string") {
      const model = toAccountAlias((next ?? result).model, account);
      if (model) next = { ...(next ?? result), model };
    }
    const settings = (next ?? result).threadSettings as Message | undefined;
    if (settings && typeof settings.model === "string") {
      const model = toAccountAlias(settings.model, account);
      if (model) next = { ...(next ?? result), threadSettings: { ...settings, model } };
    }
  }
  return next ?? result;
}

/** One chat row or object; the account is identified by its modelProvider (listing rows use provider). */
export function presentThread(thread: Message, accounts: ReadonlyMap<string, AccountRoute>): Message {
  if (!thread || typeof thread !== "object") return thread;
  const id = accountIdFromProvider(thread.modelProvider ?? thread.provider);
  const account = id ? accounts.get(id) : undefined;
  if (!account || typeof thread.model !== "string") return thread;
  const model = toAccountAlias(thread.model, account);
  return model && model !== thread.model ? { ...thread, model } : thread;
}

/** Notification rewrite for thread/started and thread/settings/updated. */
export function presentNotification(message: Message, accounts: ReadonlyMap<string, AccountRoute>): Message {
  if (message.method !== "thread/started" && message.method !== "thread/settings/updated") return message;
  const params = message.params as Message | undefined; if (!params || typeof params !== "object") return message;
  let next: Message | undefined;
  if (params.thread) { const thread = presentThread(params.thread as Message, accounts); if (thread !== params.thread) next = { ...params, thread }; }
  const settings = (next ?? params).threadSettings as Message | undefined;
  const id = settings ? accountIdFromProvider(settings.modelProvider) : undefined;
  const account = id ? accounts.get(id) : undefined;
  if (settings && account && typeof settings.model === "string") {
    const model = toAccountAlias(settings.model, account);
    if (model) next = { ...(next ?? params), threadSettings: { ...settings, model } };
  }
  return next ? { ...message, params: next } : message;
}

/** Account rows for the desktop picker: alias IDs, the label prefix, and everything else passed through. */
export function accountModelRows(rows: Message[], id: string, label: string): Message[] {
  return rows.map(row => {
    const alias = accountAlias(id, String(row.model));
    return { ...row, id: alias, model: alias, displayName: `${label} \u00b7 ${row.displayName ?? row.model}`, isDefault: false, upgrade: null, upgradeInfo: null };
  });
}

/** Mid-chat model changes keep the chat's provider family. Anything else is a provider switch. */
export function familyCheck(threadProvider: string | undefined, requested: unknown, context: RouteContext): void {
  if (typeof requested !== "string" || !requested) return;
  const refusal = "This Codex version cannot change a loaded chat between accounts or providers. Start a new chat with the selected model. Your account and existing chat are unchanged.";
  const threadAccountId = threadProvider ? accountIdFromProvider(threadProvider) : undefined;
  const alias = splitAccountAlias(requested, context.accounts.keys());
  if (threadAccountId !== undefined) {
    const account = context.accounts.get(threadAccountId);
    if (alias && alias.id === threadAccountId) return;
    if (account && account.slugs.has(requested)) return;
    throw new AccountRoutingError(refusal, -32002);
  }
  if (threadProvider === context.gatewayProvider) {
    // aliases holds the HTTP provider aliases only (shared codex/* names included). An account-only
    // alias is not an HTTP route, so a gateway chat keeps today's Claude/Codex 2 mixing unchanged.
    if (context.aliases.has(requested)) return;
    throw new AccountRoutingError(refusal, -32002);
  }
  // Native thread: native models only; every alias (HTTP or account) would switch providers.
  if (alias || context.aliases.has(requested)) throw new AccountRoutingError(refusal, -32002);
}

/** The route for a NEW chat that requested `model`. undefined means "not an account decision". */
export function routeNewChat(model: unknown, context: RouteContext): { route: "account"; id: string; wait: boolean } | { route: "http"; reason: AccountStatus } | { route: "refuse"; message: string } | undefined {
  const alias = splitAccountAlias(model, context.accounts.keys());
  if (alias) {
    const account = context.accounts.get(alias.id)!;
    if (account.status === "ready") return { route: "account", id: alias.id, wait: false };
    if (account.status === "starting" || account.status === "idle") return { route: "account", id: alias.id, wait: true };
    if (context.aliases.has(String(model))) return { route: "http", reason: account.status };
    return { route: "refuse", message: unavailableMessage(alias.id, account.status) };
  }
  // A bare upstream slug reaches the adapter only from an old saved choice: one running account may claim it.
  if (typeof model !== "string" || model.includes("/") || context.aliases.has(model)) return;
  const owners = [...context.accounts.values()].filter(account => startingStatuses.has(account.status) && account.slugs.has(model));
  if (owners.length !== 1) return;
  return { route: "account", id: owners[0].id, wait: owners[0].status !== "ready" };
}

/** The account that must serve an EXISTING thread by its provider. */
export function routeThread(provider: unknown): { id: string } | undefined {
  const id = accountIdFromProvider(provider);
  return id ? { id } : undefined;
}
