/**
 * A user-facing message for an unknown failure.
 *
 * JSON parse errors quote a slice of the file they failed on, and gateway files can hold
 * credentials, so a SyntaxError never reaches the terminal: it collapses to a fixed string.
 */
export function safeErrorMessage(error: unknown, fallback = "Command failed"): string {
  if (error instanceof SyntaxError) return "Invalid JSON data";
  if (error instanceof Error) return error.message;
  return fallback;
}
