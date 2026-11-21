import { acpLive, acpOneShotKinds, type AcpLiveDriver, type AcpLiveInput, type AcpLiveSettings } from "./acp-live.js";
import { GrokEndedStore } from "./grok-ended-store.js";
import { grokDriver } from "./grok-live-session.js";

/**
 * Live Grok sessions: one long-lived `grok agent` process per conversation. The pool, its continuation rules, its
 * refusal codes and its ended-record handling are the shared ACP ones (acp-live.ts), used unchanged by the Gemini
 * provider; this module names the Grok driver and its home so the two providers keep separate registries, telemetry
 * events and ended-session files.
 */
export type GrokLiveInput = AcpLiveInput;
export type GrokLiveSettings = AcpLiveSettings;

/** Request kinds that are deliberately served outside the conversation's session. */
export const grokOneShotKinds = acpOneShotKinds;

const grokLiveDriver: AcpLiveDriver = {
  ...grokDriver,
  event: "grok_session",
  registry: "grok-sessions",
  activity: "grok_sessions",
  storeFor: home => GrokEndedStore.forHome(home),
};

export function grokLive(settings: GrokLiveSettings) { return acpLive(grokLiveDriver, settings); }
