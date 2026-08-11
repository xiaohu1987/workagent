import type { ModelProfile, ProviderDefinition } from "@shared-types";
import type { ModelCompat } from "./types";
import { gptCompat } from "./gpt";
import { deepseekCompat } from "./deepseek";
import { grokCompat } from "./grok";
import { glmCompat } from "./glm";
import { qwenCompat } from "./qwen";
import { senseNovaCompat } from "./sensenova";
import { kimiCompat } from "./kimi";
import { hunyuanCompat } from "./hunyuan";
import { agnesCompat } from "./agnes";
import { geminiCompat } from "./gemini";

export type {
  ModelCompat,
  ModelCompatContext,
  ModelCompatToolCallMode,
  ModelGenerationContext,
  ImageGenerationProtocol,
  ImageGenerationPlan,
  VideoGenerationPlan,
  defineCompat
} from "./types";
export { gptCompat } from "./gpt";
export { deepseekCompat } from "./deepseek";
export {
  grokCompat,
  isGrokCompletionAudit,
  appendGrokCompletionAuditInstruction,
  normalizeGrokCompletionAuditDecision
} from "./grok";
export { glmCompat } from "./glm";
export { qwenCompat } from "./qwen";
export { senseNovaCompat } from "./sensenova";
export { kimiCompat } from "./kimi";
export { hunyuanCompat } from "./hunyuan";
export { agnesCompat } from "./agnes";
export { geminiCompat } from "./gemini";
export {
  imageGenerationProtocolForModel,
  providerSupportsMediaGeneration,
  IMAGE_GENERATION_PROTOCOL_LABELS
} from "./media-protocol";

/**
 * Ordered registry. Non-GPT shells are listed first so a model whose id
 * contains multiple vendor keywords prefers the more specific match; GPT is
 * the catch-all baseline both as an explicit entry and as the fallback.
 */
const registry: readonly ModelCompat[] = [
  deepseekCompat,
  grokCompat,
  glmCompat,
  qwenCompat,
  senseNovaCompat,
  kimiCompat,
  hunyuanCompat,
  agnesCompat,
  geminiCompat,
  gptCompat
];

/**
 * Resolve the compat strategy for a model by keyword inclusion. Matches
 * against the lower-cased `model.id` + `model.displayName`. Unmatched models
 * fall back to {@link gptCompat}.
 *
 * Example routing:
 *  - "deepseek-chat"      -> deepseekCompat
 *  - "grok-3"             -> grokCompat
 *  - "glm-4.5"            -> glmCompat
 *  - "qwen-max"           -> qwenCompat
 *  - "SenseNova-5"        -> senseNovaCompat
 *  - "kimi-k2" / "moonshot-v1-8k" -> kimiCompat
 *  - "hunyuan-turbos" / "hy3"     -> hunyuanCompat
 *  - "agnes-2.0-flash" / "agnes-video-v2.0" -> agnesCompat
 *  - "gemini-2.5-flash" / "imagen-3.0" -> geminiCompat
 *  - "gpt-4o" / "o3-mini" -> gptCompat
 *  - "my-custom-model"    -> gptCompat (default)
 */
export function resolveModelCompat(
  model: Pick<ModelProfile, "id" | "displayName">,
  provider?: Pick<ProviderDefinition, "id" | "name" | "baseUrl">
): ModelCompat {
  const identity = [
    model.id,
    model.displayName ?? "",
    provider?.id ?? "",
    provider?.name ?? "",
    provider?.baseUrl ?? ""
  ].join(" ").toLowerCase();
  for (const compat of registry) {
    if (compat.keywords.some((keyword) => identity.includes(keyword))) {
      return compat;
    }
  }
  return gptCompat;
}
