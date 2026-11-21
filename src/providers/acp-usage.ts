import type { Usage } from "../protocol/types.js";

/** Token counts a CLI reports for one prompt. Providers report input including cache reads. */
export interface AcpTokens { input: number; cacheRead?: number; output: number }

/** The shared token-count shape behind every ACP provider's usage (grok-stream.ts re-exports it as `grokUsage`). */
export const acpUsage = (tokens: AcpTokens): Usage => ({ input_tokens: tokens.input, output_tokens: tokens.output, total_tokens: tokens.input + tokens.output,
  ...(tokens.cacheRead === undefined ? {} : { input_tokens_details: { cached_tokens: tokens.cacheRead } }) });
