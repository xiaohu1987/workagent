import { defineCompat } from "./types";
import type { ModelCompatContext } from "./types";
import type { ProviderTurnDecision, ProviderTurnInput, RuntimeToolCall } from "@shared-types";
import { gptCompat } from "./gpt";
import { preserveChineseOutputLanguage } from "./output-language";

const QWEN_FILE_TOOL_COMPATIBILITY_MARKER = "[Qwen file-tool compatibility]";
const QWEN_FILE_TOOL_COMPATIBILITY_INSTRUCTION = [
  QWEN_FILE_TOOL_COMPATIBILITY_MARKER,
  "For every file or directory path argument, copy the exact path from a successful read, directory listing, or code-inspection result in this turn.",
  "Never reconstruct a filesystem path from a namespace, package name, class name, URL, or prose, and never add or remove repeated directory segments such as Domain.",
  "For apply_patch, pass exactly {\"patch\":\"*** Begin Patch\\n...\\n*** End Patch\"}; do not pass path/content to apply_patch.",
  "When sending a complete file as path/content, call fs.write_file instead."
].join(" ");

const VERIFIED_FILE_TOOLS = new Set([
  "fs.read_file",
  "code.outline",
  "code.ast_diff"
]);

const FILE_PATH_ARGUMENT_TOOLS = new Set([
  ...VERIFIED_FILE_TOOLS,
  "fs.write_file"
]);

/**
 * Qwen (Alibaba) openai-compatible shell.
 *
 * Reference: Qwen thinking-mode docs
 * (https://platform.qianwenai.com/docs/developer-guides/text-generation/thinking).
 *
 * Verified against official docs (no override needed for default behaviour):
 *  - reasoning_content field path matches the GPT baseline exactly:
 *    stream delta.reasoning_content / non-stream message.reasoning_content.
 *  - tool_calls follow the OpenAI shape (tools array + tool_call_id round
 *    trips), including in thinking mode where reasoning_content must be
 *    echoed back on subsequent turns (handled by the transcript builder).
 *  - Pure-reasoning models (qwq-plus, qwen3-*-thinking) always emit
 *    reasoning_content; mixed-mode models (qwen3-max/plus/flash/turbo)
 *    default to thinking OFF on commercial tiers and ON on open-source tiers.
 *
 * Not surfaced here (intentional):
 *  - `enable_thinking` / `thinking_budget` / `preserve_thinking` are
 *    non-standard params that the OpenAI SDK expects via extra_body. They are
 *    omitted by default to respect each model's native default. Add them in
 *    normalizeRequestParams when you want to force thinking on/off for a
 *    specific deployment.
 *  - DashScope native mode uses a different base URL (/compatible-mode/v1 vs
 *    /api/v1) and list-shaped content; that is a baseUrl/config concern, not
 *    a compat-layer concern.
 *
 * Tune here when you need to force enable_thinking, set thinking_budget, or
 * adjust tool-call behaviour.
 */
export const qwenCompat = defineCompat(gptCompat, {
  id: "qwen",
  keywords: ["qwen", "tongyi"],
  normalizeRequestParams(ctx: ModelCompatContext, base: Record<string, unknown>): Record<string, unknown> {
    const normalized = preserveChineseOutputLanguage(ctx, gptCompat.normalizeRequestParams(ctx, base));
    return appendQwenFileToolInstruction(ctx, normalized);
  },
  normalizeDecision(decision: ProviderTurnDecision, ctx: ModelCompatContext): ProviderTurnDecision {
    return normalizeQwenFileToolDecision(decision, ctx.input);
  }
});

function appendQwenFileToolInstruction(
  ctx: ModelCompatContext,
  request: Record<string, unknown>
): Record<string, unknown> {
  const hasFileTools = ctx.input.availableTools.some((tool) =>
    tool.name === "apply_patch" || tool.name === "fs.write_file" || tool.name === "fs.read_file"
  );
  if (!hasFileTools || !Array.isArray(request.messages)) return request;

  const systemIndex = request.messages.findLastIndex((message) =>
    !!message && typeof message === "object" && (message as { role?: unknown }).role === "system"
  );
  if (systemIndex < 0) return request;
  const systemMessage = request.messages[systemIndex];
  if (!systemMessage || typeof systemMessage !== "object") return request;
  const content = (systemMessage as { content?: unknown }).content;
  if (typeof content !== "string" || content.includes(QWEN_FILE_TOOL_COMPATIBILITY_MARKER)) return request;

  const messages = [...request.messages];
  messages[systemIndex] = {
    ...(systemMessage as Record<string, unknown>),
    content: `${content}\n\n${QWEN_FILE_TOOL_COMPATIBILITY_INSTRUCTION}`
  };
  return { ...request, messages };
}

function normalizeQwenFileToolDecision(
  decision: ProviderTurnDecision,
  input: ProviderTurnInput
): ProviderTurnDecision {
  if (decision.toolCalls.length === 0) return decision;

  const verified = collectVerifiedPaths(input.transcript);
  const availableTools = new Set(input.availableTools.map((tool) => tool.name));
  let changed = false;
  const toolCalls = decision.toolCalls.map((toolCall) => {
    const normalized = normalizeQwenToolCall(toolCall, verified, availableTools);
    if (normalized !== toolCall) changed = true;
    return normalized;
  });
  return changed ? { ...decision, toolCalls } : decision;
}

function normalizeQwenToolCall(
  toolCall: RuntimeToolCall,
  verified: { files: string[]; directories: string[] },
  availableTools: ReadonlySet<string>
): RuntimeToolCall {
  if (toolCall.name === "apply_patch") {
    const args = toolCall.arguments;
    const patch = [args.patch, args.patch_content, args.patchText].find(
      (value): value is string => typeof value === "string"
    );
    if (patch) {
      const normalizedPatch = normalizeQwenPatchPaths(patch, verified.files);
      if (args.patch === normalizedPatch && args.patch_content === undefined && args.patchText === undefined) {
        return toolCall;
      }
      return { ...toolCall, arguments: { patch: normalizedPatch } };
    }

    const filePath = typeof args.path === "string" ? args.path : null;
    const content = typeof args.content === "string" ? args.content : null;
    if (content?.trimStart().startsWith("*** Begin Patch")) {
      return {
        ...toolCall,
        arguments: { patch: normalizeQwenPatchPaths(content, verified.files) }
      };
    }
    if (filePath && content !== null && availableTools.has("fs.write_file")) {
      return {
        ...toolCall,
        name: "fs.write_file",
        arguments: {
          path: chooseVerifiedPath(filePath, verified.files),
          content
        }
      };
    }
    return toolCall;
  }

  const candidate = typeof toolCall.arguments.path === "string" ? toolCall.arguments.path : null;
  if (!candidate) return toolCall;
  const trustedPaths = toolCall.name === "fs.read_directory"
    ? verified.directories
    : FILE_PATH_ARGUMENT_TOOLS.has(toolCall.name)
      ? verified.files
      : [];
  const corrected = chooseVerifiedPath(candidate, trustedPaths);
  return corrected === candidate
    ? toolCall
    : { ...toolCall, arguments: { ...toolCall.arguments, path: corrected } };
}

function collectVerifiedPaths(
  transcript: ProviderTurnInput["transcript"]
): { files: string[]; directories: string[] } {
  const calls = new Map<string, RuntimeToolCall>();
  const files = new Set<string>();
  const directories = new Set<string>();

  for (const message of transcript) {
    for (const call of message.toolCalls ?? []) calls.set(call.id, call);
    if (message.role !== "tool" || message.toolResultOk !== true || !message.toolCallId) continue;
    const call = calls.get(message.toolCallId);
    const filePath = call && typeof call.arguments.path === "string" ? call.arguments.path.trim() : "";
    if (!filePath) continue;
    if (call?.name === "fs.read_directory") directories.add(filePath);
    else if (call && VERIFIED_FILE_TOOLS.has(call.name)) files.add(filePath);
  }

  return { files: [...files], directories: [...directories] };
}

function normalizeQwenPatchPaths(patch: string, verifiedFiles: string[]): string {
  return patch.replace(/^(\*\*\* Update File: )(.+)$/gm, (_line, prefix: string, filePath: string) =>
    `${prefix}${chooseVerifiedPath(filePath.trim(), verifiedFiles)}`
  );
}

function chooseVerifiedPath(candidate: string, verifiedPaths: string[]): string {
  const candidateNormalized = normalizePath(candidate);
  if (!candidateNormalized || verifiedPaths.some((value) => normalizePath(value) === candidateNormalized)) {
    return candidate;
  }

  const candidateSegments = comparablePathSegments(candidate);
  const candidateLeaf = candidateSegments.at(-1);
  if (!candidateLeaf) return candidate;

  const matches = verifiedPaths
    .filter((value) => comparablePathSegments(value).at(-1) === candidateLeaf)
    .filter((value) => isSafeQwenPathDrift(candidateSegments, comparablePathSegments(value)));
  if (matches.length === 0) return candidate;
  if (matches.length > 1) return candidate;
  return matches[0];
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase();
}

function comparablePathSegments(value: string): string[] {
  const segments = normalizePath(value).split("/").filter((segment) => segment && segment !== ".");
  const sourceIndex = segments.indexOf("src");
  return sourceIndex >= 0 ? segments.slice(sourceIndex) : segments;
}

function isSafeQwenPathDrift(left: string[], right: string[]): boolean {
  if (left.length === right.length) {
    const differing = left
      .map((segment, index) => segment === right[index] ? -1 : index)
      .filter((index) => index >= 0);
    if (differing.length !== 1) return false;
    const leftSegment = left[differing[0]];
    const rightSegment = right[differing[0]];
    return leftSegment.startsWith(`${rightSegment}.`) || rightSegment.startsWith(`${leftSegment}.`);
  }

  if (Math.abs(left.length - right.length) !== 1) return false;
  const longer = left.length > right.length ? left : right;
  const shorter = left.length > right.length ? right : left;
  for (let index = 0; index < longer.length; index += 1) {
    const withoutSegment = [...longer.slice(0, index), ...longer.slice(index + 1)];
    if (!withoutSegment.every((segment, candidateIndex) => segment === shorter[candidateIndex])) continue;
    const removed = longer[index];
    return longer[index - 1] === removed || longer[index + 1] === removed;
  }
  return false;
}
