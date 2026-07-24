import type { ModelProfile } from "@shared-types";
import type { ModelCompat } from "./types";
import { gptCompat } from "./gpt";
import { deepseekCompat } from "./deepseek";
import { grokCompat } from "./grok";
import { glmCompat } from "./glm";
import { qwenCompat } from "./qwen";
import { senseNovaCompat } from "./sensenova";

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
export { grokCompat } from "./grok";
export { glmCompat } from "./glm";
export { qwenCompat } from "./qwen";
export { senseNovaCompat } from "./sensenova";

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
 *  - "gpt-4o" / "o3-mini" -> gptCompat
 *  - "my-custom-model"    -> gptCompat (default)
 */
export function resolveModelCompat(
  model: Pick<ModelProfile, "id" | "displayName">
): ModelCompat {
  const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
  for (const compat of registry) {
    if (compat.keywords.some((keyword) => identity.includes(keyword))) {
      return compat;
    }
  }
  return gptCompat;
}
