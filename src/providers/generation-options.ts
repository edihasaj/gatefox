import type { ResponsesRequest } from "../protocol/types.js";
import { ProviderError } from "./provider.js";

export type GenerationOptions = {
  stop?: string[];
  temperature?: number;
  topP?: number;
  parallelToolCalls?: boolean;
};

/** Validates the portable generation controls before a provider request is sent. */
export function generationOptions(request: ResponsesRequest, temperatureMaximum: number): GenerationOptions {
  const stop = request.stop;
  if (stop !== undefined && (!Array.isArray(stop) || stop.some(value => typeof value !== "string"))) {
    throw new ProviderError("invalid_request", "stop must be an array of strings", 400);
  }
  const temperature = request.temperature;
  if (temperature !== undefined && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > temperatureMaximum)) {
    throw new ProviderError("invalid_request", `temperature must be a number from 0 to ${temperatureMaximum}`, 400);
  }
  const topP = request.top_p;
  if (topP !== undefined && (typeof topP !== "number" || !Number.isFinite(topP) || topP < 0 || topP > 1)) {
    throw new ProviderError("invalid_request", "top_p must be a number from 0 to 1", 400);
  }
  const parallelToolCalls = request.parallel_tool_calls;
  if (parallelToolCalls !== undefined && typeof parallelToolCalls !== "boolean") {
    throw new ProviderError("invalid_request", "parallel_tool_calls must be a boolean", 400);
  }
  return {
    ...(stop === undefined ? {} : { stop: [...stop] }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
  };
}
