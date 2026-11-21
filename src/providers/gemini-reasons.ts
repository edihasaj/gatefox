/**
 * Fixed vocabularies for everything the Gemini session code records or reports. Text from the CLI (a stop reason, an
 * error code, a message) never reaches telemetry or a persisted record: it is mapped through these lists first. The
 * vocabulary is the shared ACP one (acp-reasons.ts), which the Grok and Gemini providers each expose under their own names.
 */
export { acpStopReasons as geminiStopReasons, acpStopReason as geminiStopReason, type AcpStopReason as GeminiStopReason,
  acpEndReasons as geminiEndReasons, type AcpEndReason as GeminiEndReason, fixedAcpReason as fixedReason } from "./acp-reasons.js";
