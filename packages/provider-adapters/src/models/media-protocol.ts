import type { ModelProfile, ProviderType } from "@shared-types";
import type { ImageGenerationProtocol } from "./types";

/**
 * Pure media-generation routing helpers. This module must stay free of
 * Node/runtime dependencies so the settings UI (renderer) can reuse the same
 * logic the provider adapters use at runtime.
 */

/** Provider families whose adapter implements image/video generation. */
const MEDIA_CAPABLE_PROVIDER_TYPES: ReadonlySet<ProviderType> = new Set([
  "openai-compatible",
  "openrouter",
  "ollama",
  "vllm",
  "gateway"
]);

/**
 * Whether the provider's adapter implements `generateImage`/`generateVideo`.
 * Chat protocols such as anthropic/gemini/mock have no media generation
 * implementation, so image/video models attached to them fail at runtime.
 */
export function providerSupportsMediaGeneration(type: ProviderType | string): boolean {
  return MEDIA_CAPABLE_PROVIDER_TYPES.has(type as ProviderType);
}

/**
 * Resolve the effective image generation protocol for a model. Image/video
 * models never use the provider-level "接口协议" selector — their protocol is
 * derived from the model identity itself.
 */
export function imageGenerationProtocolForModel(model: Pick<ModelProfile, "id" | "displayName">): ImageGenerationProtocol {
  const identity = `${model.id} ${model.displayName}`.toLowerCase();
  if (/\bgpt-image(?:[-_]|\b)/.test(identity)) return "gpt-image-api";
  if (/\bgpt-5(?:[._-]|\b)/.test(identity)) return "gpt-responses";
  if (/\bgrok(?:[-_][a-z0-9]+)*[-_]imagine[-_]image\b/.test(identity)) return "grok-images";
  return "openai-compatible";
}

/** Human-readable labels for the settings UI. */
export const IMAGE_GENERATION_PROTOCOL_LABELS: Record<ImageGenerationProtocol, string> = {
  "gpt-image-api": "GPT 图像 API",
  "gpt-responses": "GPT Responses",
  "grok-images": "Grok 图像",
  "agnes-images": "Agnes 图像",
  "gemini-images": "Gemini 图像",
  "openai-compatible": "OpenAI 兼容图像"
};
