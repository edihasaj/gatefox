/** Claude Code's structured user_id includes a conversation UUID, not just a user identity. */
export function messagesSessionId(metadata: unknown): string | undefined {
  try {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
    const user = (metadata as { user_id?: unknown }).user_id;
    if (typeof user !== "string" || user.length > 4096 || !user.startsWith("{")) return;
    const value = JSON.parse(user) as { device_id?: unknown; account_uuid?: unknown; session_id?: unknown } | null;
    if (!value || Array.isArray(value) || typeof value.device_id !== "string" || value.device_id.length > 256
      || typeof value.account_uuid !== "string" || value.account_uuid.length > 128 || typeof value.session_id !== "string") return;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.session_id)) return value.session_id;
  } catch { /* Arbitrary user metadata is not a conversation identity. */ }
}
