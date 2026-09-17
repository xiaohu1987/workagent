import type { MessageRecord, ShareScope, ShareTarget } from "@shared-types";
import { parseStructuredEventBlocks } from "./conversation-utils";

/** Event block types that carry user-visible prose rather than tool activity. */
const PROSE_EVENT_TYPES = new Set(["commentary", "final"]);

/**
 * Extract the prose part of an assistant message. Assistant content may embed
 * `<event>` blocks for tool activity; only commentary/final blocks are part of
 * the answer the user reads, so the shared text matches the transcript.
 */
export function extractAnswerText(content: string): string {
  const normalized = (content ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const blocks = parseStructuredEventBlocks(normalized);
  if (!blocks || blocks.length === 0) return normalized;
  return blocks
    .filter((block) => PROSE_EVENT_TYPES.has(block.type))
    .map((block) => block.content.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/** Assistant messages that actually carry an answer body. */
export function selectShareAnswers(
  messages: readonly MessageRecord[],
  scope: ShareScope
): Array<{ id: string; text: string }> {
  const answers = messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({ id: message.id, text: extractAnswerText(message.content) }))
    .filter((answer) => answer.text.length > 0);
  if (scope === "all") return answers;
  return answers.length > 0 ? [answers[answers.length - 1]] : [];
}

export function countShareAnswers(messages: readonly MessageRecord[]): number {
  return messages.filter((message) => message.role === "assistant" && extractAnswerText(message.content).length > 0).length;
}

/**
 * Remove markdown syntax that WeChat would otherwise display literally.
 * Structure (headings, lists, code) is preserved as readable plain text.
 */
export function stripMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let inCodeFence = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      output.push(rawLine);
      continue;
    }
    // Table separator rows (|---|---|) carry no information in plain text.
    if (/^\|?[\s:|-]*-[\s:|-]*\|?$/.test(trimmed) && trimmed.includes("-") && trimmed.includes("|")) {
      continue;
    }
    // Horizontal rules only separate turns; they read as noise in plain text.
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
      continue;
    }
    let line = rawLine;
    line = line.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string) => alt.trim());
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, target: string) =>
      label.trim() === target.trim() ? label.trim() : `${label.trim()} (${target.trim()})`
    );
    line = line.replace(/^\s{0,3}#{1,6}\s+/, "");
    line = line.replace(/^\s{0,3}>\s?/, "");
    line = line.replace(/^\s{0,3}[-*+]\s+/, "· ");
    line = line.replace(/\*\*([^*]+)\*\*/g, "$1");
    line = line.replace(/__([^_]+)__/g, "$1");
    line = line.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
    line = line.replace(/`([^`]+)`/g, "$1");
    if (line.includes("|")) {
      line = line
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((cell) => cell.trim())
        .join("  ");
    }
    output.push(line);
  }
  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Compose the share body: the selected answers joined in transcript order.
 * The body keeps its markdown so the panel can preview the richer form; the
 * per-target rendering happens in {@link formatShareText}.
 */
export function composeTaskAnswerBody(messages: readonly MessageRecord[], scope: ShareScope): string {
  const answers = selectShareAnswers(messages, scope);
  if (answers.length === 0) return "";
  return answers.map((answer) => answer.text).join("\n\n").trim();
}

/** Render the share body for one target. DingTalk keeps markdown, WeChat does not. */
export function formatShareText(body: string, target: ShareTarget): string {
  return target === "dingtalk" ? body.trim() : stripMarkdown(body);
}

/**
 * Compose the share payload for a target in one step.
 */
export function composeShareText(input: {
  messages: readonly MessageRecord[];
  scope: ShareScope;
  target: ShareTarget;
}): string {
  return formatShareText(composeTaskAnswerBody(input.messages, input.scope), input.target);
}

/** One-line preview used by the share panel header. */
export function summarizeShareText(text: string, limit = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
