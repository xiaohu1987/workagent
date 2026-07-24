import type {
  ImageGenerationPlan,
  ModelCompat,
  ModelCompatContext,
  ModelCompatToolCallMode,
  ModelGenerationContext,
  VideoGenerationPlan
} from "./types";
import {
  extractVisibleStreamText as extractVisibleStreamTextGpt,
  imageGenerationProtocolForModel as imageGenerationProtocolForModelGpt,
  parseOpenAiCompatibleResponse as parseOpenAiCompatibleResponseGpt
} from "../index";

/**
 * Default openai-compatible behaviour, mirroring the historical
 * `OpenAiCompatibleProvider` implementation. Every other model shell starts
 * from here via {@link defineCompat}, so tuning deepseek/grok/glm/qwen/
 * sensenova never changes the GPT baseline.
 *
 * Hooks are wrapped in plain method bodies (not assigned as direct
 * references) so the imports from the parent `index.ts` are resolved lazily
 * at call time. This sidesteps the ESM circular reference (`index.ts` ->
 * `./models` -> `./gpt` -> `../index`): the module graph loads in any order,
 * and the live bindings are only read when a hook is actually invoked, by
 * which point `index.ts` has finished initialising.
 *
 * When you need to tweak GPT itself, edit this file.
 */
export const gptCompat: ModelCompat = {
  id: "gpt",
  keywords: ["gpt", "openai", "o1", "o3", "o4", "chatgpt"],

  resolveToolCallMode({ input }: ModelCompatContext): ModelCompatToolCallMode {
    const useNativeTools =
      !input.forceTextToolProtocol &&
      input.model.supportsToolCalling &&
      input.availableTools.length > 0;
    return {
      useNativeTools,
      useJsonOutput: !useNativeTools && input.model.supportsJsonOutput
    };
  },

  normalizeRequestParams(
    _ctx: ModelCompatContext,
    base: Record<string, unknown>
  ): Record<string, unknown> {
    // GPT baseline: the provider-built request is already correct.
    return base;
  },

  extractVisibleStreamText(accumulated: string): string {
    return extractVisibleStreamTextGpt(accumulated);
  },

  parseResponse(response, ctx: ModelCompatContext, hasNativeTools: boolean) {
    return parseOpenAiCompatibleResponseGpt(response, hasNativeTools, ctx.input);
  },

  extractReasoningFromDelta(delta: any): string {
    // openai-compatible reasoning convention: deepseek-reasoner, qwen-qwq,
    // and glm-thinking all stream chain-of-thought via delta.reasoning_content.
    // GPT chat-completions does not populate this field, so it returns "".
    return typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
  },

  extractReasoningFromMessage(message: any): string {
    return typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  },

  resolveImageGeneration({ model, prompt }: ModelGenerationContext): ImageGenerationPlan {
    const protocol = imageGenerationProtocolForModelGpt(model);
    if (protocol === "gpt-image-api") {
      return {
        protocol,
        endpoint: "/images/generations",
        payload: {
          model: model.id,
          prompt,
          n: 1,
          size: "1024x1024",
          quality: "medium",
          output_format: "png"
        },
        label: "GPT Image generation request"
      };
    }
    if (protocol === "gpt-responses") {
      return {
        protocol,
        endpoint: "/responses",
        payload: {
          model: model.id,
          input: prompt,
          tools: [{ type: "image_generation", action: "generate" }]
        },
        label: "GPT Responses image generation request"
      };
    }
    // GPT baseline only owns the gpt-image-api and gpt-responses protocols.
    // grok-images is implemented by grok.ts; any other model (including a
    // grok variant that is not routed to grok.ts) falls back to the OpenAI
    // SDK images.generate path here.
    return { protocol: "openai-compatible", payload: {} };
  },

  resolveVideoGeneration({ model, prompt }: ModelGenerationContext): VideoGenerationPlan {
    return {
      protocol: "openai-compatible",
      endpoint: "/videos/generations",
      payload: {
        model: model.id,
        prompt,
        duration: 10,
        aspect_ratio: "16:9",
        resolution: "480p"
      }
    };
  }
};
