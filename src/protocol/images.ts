import type { MessagePart, OpenAIChatMessage, ImageDetail } from "./types.js";
import { ResponsesTranslationError } from "./request.js";

/** Inline image data only. No remote fetches, files, or implicit conversion. */
export function inlineImage(value: unknown, detail?: unknown): Extract<MessagePart, { type: "image" }> {
  if (typeof value !== "string") throw new ResponsesTranslationError("Image input requires inline image_url data", "invalid_image");
  const match = value.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length > 8 * 1024 * 1024) throw new ResponsesTranslationError("Image input must be PNG, JPEG, GIF, or WebP base64 data within 8 MiB", "invalid_image");
  if (detail !== undefined && !["auto", "low", "high", "original"].includes(String(detail))) throw new ResponsesTranslationError("Unsupported image detail", "invalid_image");
  const bytes = Buffer.from(match[2], "base64");
  const signatures: Record<string, boolean> = {
    "image/png": bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/jpeg": bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    "image/gif": ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")),
    "image/webp": bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP",
  };
  if (bytes.toString("base64") !== match[2] || !signatures[match[1]]) throw new ResponsesTranslationError("Image encoding or media type is invalid", "invalid_image");
  return { type: "image", mediaType: match[1], data: match[2], ...(detail !== undefined ? { detail: detail as ImageDetail } : {}) };
}

/** Keep image bytes out of the serialized text conversation. Labels retain ownership and order. */
export function imageConversation(messages: OpenAIChatMessage[]) {
  const images: Array<{ label: string; image: Extract<MessagePart, { type: "image" }> }> = [];
  const conversation = messages.map((message, messageIndex) => {
    if (!message.parts) return message;
    const parts = message.parts.map((part, partIndex) => {
      if (part.type !== "image") return part;
      const label = `conversation-message-${messageIndex + 1}-part-${partIndex + 1}`;
      images.push({ label, image: part }); return { type: "image", label };
    });
    return { ...message, parts };
  });
  return { conversation, images };
}

export function anthropicParts(message: OpenAIChatMessage): Array<Record<string, unknown>> {
  if (!message.parts) return message.content ? [{ type: "text", text: message.content }] : [];
  return message.parts.map(part => part.type === "text" ? { type: "text", text: part.text } : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } });
}
