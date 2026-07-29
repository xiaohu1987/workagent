import type { ModelCompatContext } from "./types";

const CHINESE_OUTPUT_COMPATIBILITY_MARKER = "[Chinese output compatibility]";
const CHINESE_OUTPUT_COMPATIBILITY_INSTRUCTION = [
  CHINESE_OUTPUT_COMPATIBILITY_MARKER,
  "The recent user conversation is in Chinese. Keep every user-visible natural-language response, including assistant_message and short progress updates, in Simplified Chinese.",
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

/** Adds a late, model-specific language reminder after the shared English agent prompt. */
export function preserveChineseOutputLanguage(
  context: ModelCompatContext,
  request: Record<string, unknown>
): Record<string, unknown> {
  if (!shouldPreserveChineseOutput(context) || !Array.isArray(request.messages)) return request;

  const systemIndex = request.messages.findLastIndex((message) =>
    !!message && typeof message === "object" && (message as { role?: unknown }).role === "system"
  );
  if (systemIndex < 0) return request;

  const systemMessage = request.messages[systemIndex];
  if (!systemMessage || typeof systemMessage !== "object") return request;
  const content = (systemMessage as { content?: unknown }).content;
  if (typeof content !== "string" || content.includes(CHINESE_OUTPUT_COMPATIBILITY_MARKER)) return request;

  const messages = [...request.messages];
  messages[systemIndex] = {
    ...(systemMessage as Record<string, unknown>),
    content: `${content}\n\n${CHINESE_OUTPUT_COMPATIBILITY_INSTRUCTION}`
  };
  return { ...request, messages };
}
