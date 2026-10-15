import { defineCompat } from "./types";
import type { ModelCompatContext } from "./types";
import { gptCompat } from "./gpt";

/**
 * GLM (Zhipu) openai-compatible shell.
 *
 * Reference: Zhipu AI thinking docs
 * (https://docs.bigmodel.cn/cn/guide/start/concept-param,
 *  https://docs.bigmodel.cn/api-reference/模型-api/对话补全).
 *
 * Verified against official docs (2026-10):
 *  - `thinking.type`: GLM-4.5+ 支持 enabled/disabled。GLM-5.3 / GLM-5.3-FLASH
 *    不再接受 disabled（传了直接报错），思考只能通过 reasoning_effort=low 降档。
 *  - `reasoning_effort`: 仅 GLM-5.2 及以上支持，默认 max。
 *    * GLM-5.3 / GLM-5.3-FLASH 仅接受 low / high / max，其它档位报错；
 *      官方兼容映射：none/minimal/low → low，medium/high → high，xhigh/max → max。
 *    * GLM-5.2：none/minimal 表示放弃思考；low/medium 服务端映射为 high；
 *      xhigh 映射为 max。
 *    * GLM-5.1 及以下：没有 reasoning_effort 入参，只有 thinking.type 开关。
 *  - reasoning_content field path matches the GPT baseline exactly:
 *    stream delta.reasoning_content / non-stream message.reasoning_content.
 *  - tool_calls follow the OpenAI shape. GLM additionally offers a
 *    tool_stream flag for streaming tool args, but it defaults to off and the
 *    OpenAI shape is used as-is.
 */
function glmVersionOf(identity: string): { major: number; minor: number } | null {
  const match = /\bglm-(\d+)(?:\.(\d+))?/.exec(identity);
  if (!match) return null;
  return { major: Number(match[1]), minor: match[2] === undefined ? 0 : Number(match[2]) };
}

/** GLM-5.3+ 的官方兼容映射（档位只有 low/high/max）。 */
function mapGlm53ReasoningEffort(value: unknown): "low" | "high" | "max" {
  if (value === "xhigh" || value === "max") return "max";
  if (value === "medium" || value === "high") return "high";
  return "low";
}

export const glmCompat = defineCompat(gptCompat, {
  id: "glm",
  keywords: ["glm", "chatglm"],
  normalizeRequestParams(ctx: ModelCompatContext, base: Record<string, unknown>): Record<string, unknown> {
    const effort = ctx.input.reasoningEffort;
    if (effort === undefined) return base;
    const identity = `${ctx.model.id} ${ctx.model.displayName ?? ""}`.toLowerCase();
    const version = glmVersionOf(identity);
    const isGlm53Plus = version !== null && (version.major > 5 || (version.major === 5 && version.minor >= 3));
    const isGlm52Plus = version !== null && (version.major > 5 || (version.major === 5 && version.minor >= 2));
    if (!isGlm52Plus) {
      // GLM-5.1 及以下（含 glm-4.x / chatglm 旧命名）：只有 thinking.type 开关。
      const enabled = effort !== "none" && effort !== "minimal";
      return { ...base, thinking: { type: enabled ? "enabled" : "disabled" } };
    }
    if (isGlm53Plus) {
      // GLM-5.3+：思考不可关闭；档位收敛到官方支持的 low/high/max。
      return { ...base, thinking: { type: "enabled" }, reasoning_effort: mapGlm53ReasoningEffort(effort) };
    }
    // GLM-5.2：none/minimal 表示放弃思考；其余档位原样传（服务端自行映射）。
    const disabled = effort === "none" || effort === "minimal";
    return {
      ...base,
      thinking: { type: disabled ? "disabled" : "enabled" },
      reasoning_effort: disabled ? "none" : (effort as string)
    };
  }
});
