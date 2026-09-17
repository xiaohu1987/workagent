import type {
  MessageRecord,
  ShareChannel,
  ShareTaskStats
} from "@shared-types";
import { getDisplayMessageContent, type FileChangeSummaryItem } from "./conversation-utils";
import { extractAnswerText } from "./share-text";

/**
 * Pure helpers behind the share panel. Everything here is DOM-free so the
 * turn grouping, range selection and statistics can be unit tested without a
 * renderer environment, and so the shared payload is derived from the same
 * message list the transcript renders.
 */

/** Assistant answers in a turn that carry no comment. */
export type ShareTurnAnswer = { id: string; content: string };

export type ShareTurn = {
  id: string;
  /** First line of the user prompt; the picker row label. */
  prompt: string;
  createdAt: string;
  /** Runtime turn ids contributing to this turn, used to attribute tools/files. */
  turnRunIds: string[];
  /** User prompt markdown, or null for content that precedes any prompt. */
  question: string | null;
  answers: ShareTurnAnswer[];
  /** Transcript messages of the turn, in order, for rendering the card. */
  messages: MessageRecord[];
  charCount: number;
};

/** Turn id used for assistant content that arrives before the first prompt. */
export const LEADING_SHARE_TURN_ID = "share-turn-leading";

/** Separator placed between turns in the composed markdown body. */
const TURN_SEPARATOR = "\n\n---\n\n";

function firstLine(value: string): string {
  const line = value
    .split("\n")
    .map((item) => item.trim())
    .find(Boolean) ?? "";
  return line.replace(/^#{1,6}\s+/, "").replace(/\s+/g, " ").trim();
}

function answerCharCount(turn: ShareTurn): number {
  return turn.answers.reduce((total, answer) => total + answer.content.length, turn.question?.length ?? 0);
}

/**
 * Group the transcript into conversation turns. A turn starts at every user
 * message, so the picker mirrors the transcript the user is looking at rather
 * than the runtime's internal turn ids (which are absent on optimistic and
 * legacy messages). Assistant prose that precedes the first prompt is kept in
 * a leading turn instead of being dropped.
 */
export function buildShareTurns(messages: readonly MessageRecord[]): ShareTurn[] {
  const turns: ShareTurn[] = [];
  let current: ShareTurn | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      const question = getDisplayMessageContent(message).trim();
      const turn: ShareTurn = {
        id: `share-turn-${message.id}`,
        prompt: firstLine(question).slice(0, 80),
        createdAt: message.createdAt,
        turnRunIds: message.turnRunId ? [message.turnRunId] : [],
        question: question || null,
        answers: [],
        messages: [message],
        charCount: 0
      };
      turns.push(turn);
      current = turn;
      continue;
    }

    if (message.role !== "assistant") continue;
    const content = extractAnswerText(message.content);
    if (!content) continue;

    if (!current) {
      const leading: ShareTurn = {
        id: LEADING_SHARE_TURN_ID,
        prompt: "",
        createdAt: message.createdAt,
        turnRunIds: [],
        question: null,
        answers: [],
        messages: [],
        charCount: 0
      };
      turns.push(leading);
      current = leading;
    }

    const turn: ShareTurn = current;
    if (message.turnRunId && !turn.turnRunIds.includes(message.turnRunId)) {
      turn.turnRunIds.push(message.turnRunId);
    }
    turn.answers.push({ id: message.id, content });
    turn.messages.push(message);
  }

  return turns
    .filter((turn) => turn.answers.length > 0)
    .map((turn) => ({ ...turn, charCount: answerCharCount(turn) }));
}

/**
 * Headline statistics for the panel header. Tool calls and file changes are
 * attributed through the runtime turn ids the selected turns collected, which
 * keeps the counts consistent with the transcript (a turn can span several
 * runtime ids when a task was continued).
 */
export function computeShareStats(
  turns: readonly ShareTurn[],
  selectedIds: readonly string[],
  toolCalls: readonly { turnRunId: string }[],
  filesByTurn: ReadonlyMap<string, readonly FileChangeSummaryItem[]>
): ShareTaskStats {
  const selected = new Set(selectedIds);
  const turnRunIds = new Set<string>();
  let conversations = 0;

  for (const turn of turns) {
    if (!selected.has(turn.id) || turn.answers.length === 0) continue;
    conversations += 1;
    for (const turnRunId of turn.turnRunIds) turnRunIds.add(turnRunId);
  }

  const files = new Set<string>();
  for (const [turnRunId, items] of filesByTurn) {
    if (!turnRunIds.has(turnRunId)) continue;
    for (const item of items) files.add(item.path);
  }

  return {
    conversations,
    toolCalls: toolCalls.filter((call) => turnRunIds.has(call.turnRunId)).length,
    files: files.size
  };
}

export function formatShareStats(stats: ShareTaskStats): string {
  return `${stats.conversations} 轮对话 · ${stats.toolCalls} 次工具调用 · ${stats.files} 个文件`;
}

/** File name offered by the save channel. */
export function buildShareFileName(threadTitle: string, extension = "png"): string {
  const safe = (threadTitle || "codexh-对话")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "codexh-对话";
  return `${safe}.${extension}`;
}

/** Channels that deliver the rendered image, in panel order. */
export const SHARE_IMAGE_CHANNELS: readonly ShareChannel[] = ["wechat", "dingtalk", "copyImage", "saveImage"] as const;

/**
 * Message-level selection used by the share bar.
 *
 * The bar lets the user tick individual messages straight in the transcript
 * instead of picking whole turns in a dialog, so selection is keyed by message
 * id and the turn list is only used to attribute tool calls and file changes.
 */

/** The markdown a message contributes to the share, or "" when it has none. */
export function shareMessageText(message: MessageRecord): string {
  if (message.role === "user") return getDisplayMessageContent(message).trim();
  if (message.role === "assistant") return extractAnswerText(message.content);
  return "";
}

/** A message is offered by the share bar only when it carries visible prose. */
export function isShareableMessage(message: MessageRecord): boolean {
  return shareMessageText(message).length > 0;
}

export function allShareMessageIds(messages: readonly MessageRecord[]): string[] {
  return messages.filter(isShareableMessage).map((message) => message.id);
}

/**
 * Default range when the share bar opens: every shareable message of the most
 * recent answered turn. That keeps the old "final answer" starting point while
 * still letting the user drop individual messages afterwards.
 */
export function defaultShareMessageIds(messages: readonly MessageRecord[]): string[] {
  const turns = buildShareTurns(messages);
  const latest = turns[turns.length - 1];
  if (!latest) return [];
  return latest.messages.filter(isShareableMessage).map((message) => message.id);
}

/** Turn ids touched by the selection; drives tool-call and file attribution. */
export function shareTurnIdsForMessages(
  turns: readonly ShareTurn[],
  selectedMessageIds: readonly string[]
): string[] {
  const selected = new Set(selectedMessageIds);
  return turns
    .filter((turn) => turn.messages.some((message) => selected.has(message.id)))
    .map((turn) => turn.id);
}

/** Selected messages in transcript order, ready for the capture card. */
export function shareMessagesById(
  messages: readonly MessageRecord[],
  selectedMessageIds: readonly string[]
): MessageRecord[] {
  const selected = new Set(selectedMessageIds);
  return messages.filter((message) => selected.has(message.id));
}

/**
 * Compose the markdown body from the selected messages. A user prompt opens a
 * block that collects the answers following it, and blocks are separated by a
 * rule — so a partial selection still reads like the transcript rather than a
 * pile of orphaned paragraphs.
 */
export function composeShareMessageMarkdown(
  messages: readonly MessageRecord[],
  selectedMessageIds: readonly string[]
): string {
  const selected = new Set(selectedMessageIds);
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const block = current.join("\n\n").trim();
    if (block) blocks.push(block);
    current = [];
  };

  for (const message of messages) {
    if (!selected.has(message.id)) continue;
    if (message.role === "user") flush();
    const text = shareMessageText(message).trim();
    if (text) current.push(text);
  }
  flush();

  return blocks.join(TURN_SEPARATOR).trim();
}
