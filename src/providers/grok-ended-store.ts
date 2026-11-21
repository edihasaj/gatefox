import { join } from "node:path";
import { AcpEndedStore, acpEndedFile, type AcpEndedStoreOptions } from "./acp-ended-store.js";
import { fixedReason } from "./grok-reasons.js";

/**
 * The persisted record of conversations whose live Grok session ended or may still run. The mechanism is the shared
 * ACP ended-session store (acp-ended-store.ts), shared with the Gemini provider: a conversation in it is never started
 * again, only sha256 key hashes, a time, a write sequence and a fixed reason code are stored, the file is private
 * (0600) and written atomically, and every operation runs under the cross-process lock. This subclass fixes the
 * vocabulary to Grok's fixed reasons and the file to the Grok home.
 */
export { AcpEndedStoreError as GrokEndedStoreError, acpEndedFile as grokEndedFile, acpEndedLimits as grokEndedLimits } from "./acp-ended-store.js";

export class GrokEndedStore extends AcpEndedStore {
  constructor(path: string, options: Omit<AcpEndedStoreOptions, "reasons"> = {}) { super(path, { ...options, reasons: fixedReason }); }
  static forHome(home: string, options: Omit<AcpEndedStoreOptions, "reasons"> = {}): GrokEndedStore { return new GrokEndedStore(join(home, acpEndedFile), options); }
}
