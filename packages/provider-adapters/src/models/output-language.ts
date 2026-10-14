import type { ModelCompatContext } from "./types";

const CHINESE_OUTPUT_COMPATIBILITY_MARKER = "[Chinese output compatibility]";
const CHINESE_OUTPUT_COMPATIBILITY_INSTRUCTION = [
  CHINESE_OUTPUT_COMPATIBILITY_MARKER,
  "When the latest user request is in Chinese, or a short follow-up continues a conversation established in Chinese, use Simplified Chinese for every user-visible natural-language response, including assistant_message and short progress updates.",
  "CRITICAL: Any thinking content surfaced in this app MUST also be written directly in Simplified Chinese, never drafted in English and translated afterward. This includes analysis, plans, and the deep-thinking panel content from every reasoning channel this transport can emit: the Responses API reasoning summary (reasoning_summary_text), the Chat Completions reasoning_content field, and any <think> blocks. Think and write these surfaced thoughts in Simplified Chinese even if system instructions, tool output, code, commands, paths, API fields, or earlier messages are English. 请始终用简体中文思考并书写展示给用户的推理摘要、分析与规划；Responses 通道的 reasoning summary 摘要也必须使用简体中文。",
  "Do not switch to English because system instructions, tool output, code, commands, paths, API fields, or earlier assistant content are English.",
  "Keep code, commands, file paths, API field names, and quoted source text unchanged. Honor an explicit user request to answer or translate in another language."
].join(" ");

function hasExplicitNonChineseLanguageRequest(content: string): boolean {
  return /(?:\b(?:answer|reply|respond|write|translate)\s+(?:in|to)\s+(?:english|chinese|japanese|korean)\b|[用以]英文(?:回答|回复|答复)?|翻译[成為为]?英文|用日文(?:回答|回复|答复)?|用韩文(?:回答|回复|答复)?)/i.test(content);
}

function shouldPreserveChineseOutput(context: ModelCompatContext): boolean {
  const userMessages = context.input.transcript
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const latestUserMessage = userMessages.at(-1) ?? "";
  if (hasExplicitNonChineseLanguageRequest(latestUserMessage)) return false;

  // A short follow-up such as "continue" should retain the language established
  // by the preceding Chinese user message instead of falling back to English.
  return userMessages.slice(-8).some((message) => /[\u3400-\u9fff]/.test(message));
}

/**
 * Adds a late, model-specific language reminder after the shared English agent
 * prompt. It covers visible replies and strongly enforces Simplified Chinese
 * for the deep-thinking / reasoning content (reasoning_content, <think> blocks)
 * that this app surfaces to the user.
 *
 * The reminder is routed to whichever system field the active transport
 * actually sends: Chat Completions carries `messages[role=system]`, while the
 * Responses transport (the default for GPT-family models) carries
 * `instructions` and has no message array at all.
 */
export function preserveChineseOutputLanguage(
  context: ModelCompatContext,
  request: Record<string, unknown>
): Record<string, unknown> {
  if (!shouldPreserveChineseOutput(context)) return request;
  return appendToChatSystemMessage(request) ?? appendToResponsesInstructions(request) ?? request;
}

/**
 * Appends the reminder to the Chat Completions system message. Returns null
 * when this request shape does not apply, so the caller can try the next
 * transport instead of treating "nothing to do" as a handled request.
 */
function appendToChatSystemMessage(
  request: Record<string, unknown>
): Record<string, unknown> | null {
  if (!Array.isArray(request.messages)) return null;

  // Scan backwards instead of using findLastIndex so the file stays
  // compatible with the project's current TypeScript lib target.
  let systemIndex = -1;
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (!!message && typeof message === "object" && (message as { role?: unknown }).role === "system") {
      systemIndex = index;
      break;
    }
  }
  if (systemIndex < 0) return null;

  const systemMessage = request.messages[systemIndex];
  if (!systemMessage || typeof systemMessage !== "object") return null;
  const content = (systemMessage as { content?: unknown }).content;
  if (typeof content !== "string" || content.includes(CHINESE_OUTPUT_COMPATIBILITY_MARKER)) return null;

  const messages = [...request.messages];
  messages[systemIndex] = {
    ...(systemMessage as Record<string, unknown>),
    content: `${content}\n\n${CHINESE_OUTPUT_COMPATIBILITY_INSTRUCTION}`
  };
  return { ...request, messages };
}

/**
 * Appends the reminder to the Responses `instructions` field. GPT-family
 * models default to this transport (`openai_responses`), and it never builds a
 * `messages` array, so `instructions` is the only channel that can carry the
 * Chinese-thinking requirement to the model. An empty system prompt is left
 * untouched, mirroring the Chat path's "no system message, no injection".
 */
function appendToResponsesInstructions(
  request: Record<string, unknown>
): Record<string, unknown> | null {
  const instructions = request.instructions;
  if (typeof instructions !== "string" || !instructions.trim()) return null;
  if (instructions.includes(CHINESE_OUTPUT_COMPATIBILITY_MARKER)) return null;
  return {
    ...request,
    instructions: `${instructions}\n\n${CHINESE_OUTPUT_COMPATIBILITY_INSTRUCTION}`
  };
}
