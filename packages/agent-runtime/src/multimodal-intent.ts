import { modelJsonCandidates, tryParseModelJson } from "@shared-types";
import type { MessageAttachment, MessageRole } from "@shared-types";

export type MultimodalIntent = "image" | "video" | null;

export type MultimodalIntentKind = "image" | "video" | "none";

export type MultimodalIntentClassification = {
  intent: MultimodalIntentKind;
  prompt: string;
  parseOk: boolean;
};

export const MULTIMODAL_INTENT_CLASSIFY_TIMEOUT_MS = 20_000;
export const MULTIMODAL_INTENT_CONTEXT_MESSAGES = 8;

/**
 * System prompt for a lightweight multimodal intent call.
 * The model must return only a small JSON object — not the Agent decision envelope.
 */
export function buildMultimodalIntentClassifySystemPrompt(): string {
  return [
    "You classify whether the latest user message is asking to generate or regenerate an image or a video.",
    "Reply with ONLY one JSON object and no other text:",
    '{"intent":"image"|"video"|"none","prompt":"..."}',
    "",
    "Rules:",
    '- intent="image" when the user wants a new image, another variation, redraw, restyle, or image edit that should produce a new image.',
    '- intent="video" when the user wants a new video or another video variation.',
    '- intent="none" for ordinary chat, coding, Q&A, or anything that is not image/video generation.',
    '- When intent is image or video, prompt MUST be a complete text prompt suitable to send directly to an image/video model.',
    '- Follow-ups like "再换一张", "换一张", "再来一张", "换个风格", "重新生成", "再试一次", "开启了你再试试": reuse the latest prior image/video generation request from conversation context, and revise the prompt only if the user added new constraints.',
    "- If the latest assistant tip said image/video generation is disabled or missing a default model, and the user confirms retry, reuse the original generation request as prompt.",
    '- When intent is "none", set prompt to an empty string.',
    "- Do not call tools. Do not wrap the JSON in an Agent decision envelope."
  ].join("\n");
}

export function buildMultimodalIntentClassifyTranscript(input: {
  priorMessages: Array<{ role: string; content: string }>;
  currentInput: string;
  attachments?: MessageAttachment[];
}): Array<{ role: MessageRole; content: string }> {
  const recent = input.priorMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-MULTIMODAL_INTENT_CONTEXT_MESSAGES)
    .map((message) => ({
      role: message.role as MessageRole,
      content: truncateForClassify(message.content)
    }));

  const attachmentNote = describeAttachments(input.attachments ?? []);
  const current = input.currentInput.trim();
  const content = attachmentNote
    ? `${current}${current ? "\n" : ""}${attachmentNote}`
    : current || attachmentNote;

  return [
    ...recent,
    {
      role: "user",
      content: content || "(empty message)"
    }
  ];
}

export function parseMultimodalIntentClassification(raw: string): MultimodalIntentClassification {
  const text = stripCodeFences(raw.trim());
  if (!text) {
    return { intent: "none", prompt: "", parseOk: false };
  }

  const candidates = modelJsonCandidates(text);

  for (const candidate of candidates) {
    const parsed = tryParseModelJson(candidate);
    if (!isRecord(parsed)) continue;
    const fromNested =
      typeof parsed.assistant_message === "string"
        ? tryParseIntentObject(parsed.assistant_message)
        : null;
    const result = fromNested ?? normalizeIntentObject(parsed);
    if (result) return result;
  }

  return { intent: "none", prompt: "", parseOk: false };
}

function tryParseIntentObject(raw: string): MultimodalIntentClassification | null {
  const text = stripCodeFences(raw.trim());
  for (const candidate of modelJsonCandidates(text)) {
    const parsed = tryParseModelJson(candidate);
    if (isRecord(parsed)) {
      return normalizeIntentObject(parsed);
    }
  }
  return null;
}

function normalizeIntentObject(parsed: Record<string, unknown>): MultimodalIntentClassification | null {
  const intentRaw = typeof parsed.intent === "string" ? parsed.intent.trim().toLowerCase() : "";
  if (intentRaw !== "image" && intentRaw !== "video" && intentRaw !== "none") {
    return null;
  }
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
  if ((intentRaw === "image" || intentRaw === "video") && !prompt) {
    return { intent: "none", prompt: "", parseOk: false };
  }
  return {
    intent: intentRaw,
    prompt: intentRaw === "none" ? "" : prompt,
    parseOk: true
  };
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function truncateForClassify(content: string, maxChars = 600): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
}

function describeAttachments(attachments: MessageAttachment[]): string {
  if (attachments.length === 0) return "";
  const kinds = attachments.map((item) => item.kind).join(", ");
  return `[attachments: ${kinds}]`;
}

/** @deprecated Prefer model-based classification. Kept for debug/tests only. */
export function detectMultimodalIntent(
  input: string,
  attachments: MessageAttachment[] = []
): MultimodalIntent {
  const text = input.trim();
  if (!text && attachments.length === 0) return null;
  if (/视频|video/i.test(text) && /生成|做|出|create|generate/i.test(text)) return "video";
  if (/图|画|image|draw/i.test(text) && /生成|画|做|出|create|generate|draw/i.test(text)) return "image";
  if (attachments.some((item) => item.kind === "image") && /改|修|重绘|图中|图里/.test(text)) {
    return "image";
  }
  return null;
}
