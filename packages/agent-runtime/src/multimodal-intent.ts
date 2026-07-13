import type { MessageAttachment } from "@shared-types";

export type MultimodalIntent = "image" | "video" | null;

const IMAGE_PATTERNS: RegExp[] = [
  /生图/,
  /文生图/,
  /帮我画/,
  /请画/,
  /画一张/,
  /画一幅/,
  /画个/,
  /生成图片/,
  /生成一张图/,
  /生成一幅图/,
  /出一张图/,
  /做一张图/,
  // 允许中间插入修饰词，例如：生成一张性感美女图片 / 生成一整美女出浴图
  /生成.{0,24}图/,
  /画.{0,16}图/,
  /做.{0,16}(一张|一幅|个)?.{0,12}图/,
  /来一张图/,
  /给我.{0,12}图/,
  /出一张.{0,16}图/,
  /text[\s-]?to[\s-]?image/i,
  /\bgenerate\s+(an?\s+)?image\b/i,
  /\bdraw\s+(an?\s+)?image\b/i,
  /\bcreate\s+(an?\s+)?image\b/i
];

const VIDEO_PATTERNS: RegExp[] = [
  /生成视频/,
  /做个视频/,
  /做一段视频/,
  /文生视频/,
  /出一段视频/,
  /帮我生成视频/,
  /生成.{0,16}视频/,
  /text[\s-]?to[\s-]?video/i,
  /\bgenerate\s+(an?\s+)?video\b/i,
  /\bcreate\s+(an?\s+)?video\b/i
];

const IMAGE_EDIT_HINTS: RegExp[] = [
  /改图/,
  /修图/,
  /重绘/,
  /基于这[张幅]图/,
  /根据这[张幅]图/,
  /把这[张幅]图/,
  /把上[一1]张图/,
  /上一张图/,
  /把图中/,
  /把图里/,
  /图中的.{0,20}改/,
  /图里的.{0,20}改/
];

/** Short follow-ups after a multimodal tip, e.g. “开启了 你再试试”. */
const MULTIMODAL_RETRY_CONFIRMATIONS: RegExp[] = [
  /^(开启了|已开启|打开了|已打开|好了|可以了|行了|继续|再试|再试试|再试一次|重新生成|重试)[.!！。…\s]*$/i,
  /开启了.{0,12}再试/,
  /已开启.{0,12}(再试|继续)/,
  /打开了.{0,12}(再试|继续)/,
  /再试(试|一次)/,
  /^(ok|okay|done)[.!！。\s]*$/i
];

export function detectMultimodalIntent(
  input: string,
  attachments: MessageAttachment[] = []
): MultimodalIntent {
  const text = input.trim();
  if (!text && attachments.length === 0) {
    return null;
  }

  if (VIDEO_PATTERNS.some((pattern) => pattern.test(text))) {
    return "video";
  }
  if (IMAGE_PATTERNS.some((pattern) => pattern.test(text))) {
    return "image";
  }

  const hasImageAttachment = attachments.some((item) => item.kind === "image");
  if (IMAGE_EDIT_HINTS.some((pattern) => pattern.test(text))) {
    // 继续改图：有附图，或对话里明确指向上一张图
    if (hasImageAttachment || /上[一1]张图|把图中|把图里|图中的|图里的/.test(text)) {
      return "image";
    }
  }

  return null;
}

export function detectMultimodalRetryConfirmation(input: string): boolean {
  const text = input.trim();
  if (!text || text.length > 40) return false;
  return MULTIMODAL_RETRY_CONFIRMATIONS.some((pattern) => pattern.test(text));
}

export function detectMultimodalTipIntent(content: string): MultimodalIntent {
  const text = content.trim();
  if (/视频生成已关闭|尚未(?:设置|配置)?默认视频|尚未配置视频|默认视频模型/.test(text)) {
    return "video";
  }
  if (/图片生成已关闭|尚未(?:设置|配置)?默认图片|尚未配置图片|默认图片模型/.test(text)) {
    return "image";
  }
  return null;
}

/**
 * Resolve multimodal routing for this turn.
 * - Direct keyword/intent match on the current message
 * - Or a short confirmation that retries the previous multimodal request after a tip
 */
export function resolveMultimodalTurnRequest(input: {
  currentInput: string;
  attachments?: MessageAttachment[];
  priorMessages: Array<{ role: string; content: string }>;
}): { intent: "image" | "video"; prompt: string; viaRetry: boolean } | null {
  const direct = detectMultimodalIntent(input.currentInput, input.attachments ?? []);
  if (direct) {
    return { intent: direct, prompt: input.currentInput.trim(), viaRetry: false };
  }

  if (!detectMultimodalRetryConfirmation(input.currentInput)) {
    return null;
  }

  const prior = input.priorMessages;
  for (let index = prior.length - 1; index >= 0; index -= 1) {
    const message = prior[index];
    if (message.role !== "assistant") continue;
    const tipIntent = detectMultimodalTipIntent(message.content);
    if (!tipIntent) {
      if (/已生成(?:图片|视频)/.test(message.content)) {
        return null;
      }
      continue;
    }
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = prior[cursor];
      if (candidate.role !== "user") continue;
      const intent = detectMultimodalIntent(candidate.content, []) ?? tipIntent;
      return {
        intent,
        prompt: candidate.content.trim(),
        viaRetry: true
      };
    }
    return null;
  }

  return null;
}

export function describeMultimodalIntentMatch(input: string): {
  intent: MultimodalIntent;
  matchedPattern: string | null;
} {
  const text = input.trim();
  for (const pattern of VIDEO_PATTERNS) {
    if (pattern.test(text)) return { intent: "video", matchedPattern: String(pattern) };
  }
  for (const pattern of IMAGE_PATTERNS) {
    if (pattern.test(text)) return { intent: "image", matchedPattern: String(pattern) };
  }
  for (const pattern of IMAGE_EDIT_HINTS) {
    if (pattern.test(text)) return { intent: "image", matchedPattern: String(pattern) };
  }
  return { intent: null, matchedPattern: null };
}
