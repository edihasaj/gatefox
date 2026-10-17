/** A request the adapter refuses with fixed gateway text; telemetry may record the message as the reason. */
export class AppServerRoutingError extends Error {
  constructor(message: string, readonly code: number = -32600) { super(message); }
}
