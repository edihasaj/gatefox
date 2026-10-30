import type { MessagePart } from "../protocol/types.js";

/**
 * Images for Chat Completions models whose metadata lists `image` input (local Qwen through vLLM). Images arrive already
 * validated as inline base64 PNG, JPEG, GIF or WebP (protocol/images.ts) and leave as OpenAI `image_url` data URLs. A user
 * message keeps its text and images in their original order. A tool result keeps its text in the tool message, because
 * Chat Completions tool messages carry text only; its images follow in one user message after the run of tool results,
 * so the tool results stay contiguous after the assistant's calls.
 */
export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ImagePart = Extract<MessagePart, { type: "image" }>;

export const imagesOf = (parts: readonly MessagePart[] | undefined): ImagePart[] => (parts || []).filter((part): part is ImagePart => part.type === "image");
export const imageUrlPart = (image: ImagePart): ChatContentPart => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } });

/** A user message's parts as Chat Completions content, text and images in order. */
export const userContent = (parts: readonly MessagePart[]): ChatContentPart[] =>
  parts.map(part => part.type === "text" ? { type: "text" as const, text: part.text } : imageUrlPart(part));

/** The user message that carries the images a run of tool results returned. */
export const toolImagesMessage = (images: readonly ImagePart[]) => ({ role: "user" as const,
  content: [{ type: "text" as const, text: images.length === 1 ? "Image returned by the preceding tool call:" : "Images returned by the preceding tool calls:" }, ...images.map(imageUrlPart)] });
