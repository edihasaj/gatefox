import { acpLive, acpOneShotKinds, type AcpLiveDriver, type AcpLiveInput, type AcpLiveSettings } from "./acp-live.js";
import { GeminiEndedStore } from "./gemini-ended-store.js";
import { geminiDriver } from "./gemini-live-session.js";

/**
 * Live Gemini sessions: one long-lived `gemini --acp` process per conversation. The pool, its continuation rules, its
 * refusal codes and its ended-record handling are the shared ACP ones (acp-live.ts), used unchanged by the Grok
 * provider; this module names the Gemini driver and its home so the two providers keep separate registries, telemetry
 * events and ended-session files.
 */
export type GeminiLiveInput = AcpLiveInput;
export type GeminiLiveSettings = AcpLiveSettings;

/** Request kinds that are served outside a conversation's session, which Gemini has no transport for. */
export const geminiOneShotKinds = acpOneShotKinds;

const geminiLiveDriver: AcpLiveDriver = {
  ...geminiDriver,
  event: "gemini_session",
  registry: "gemini-sessions",
  activity: "gemini_sessions",
  storeFor: home => GeminiEndedStore.forHome(home),
};

export function geminiLive(settings: GeminiLiveSettings) { return acpLive(geminiLiveDriver, settings); }
