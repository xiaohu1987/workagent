import { surfaceThinkBlocksInStream } from "../index";
import { defineCompat } from "./types";
import type { ModelCompatContext } from "./types";
import type { ModelProfile, ProviderTurnDecision, ProviderTurnInput, RuntimeToolCall } from "@shared-types";
import { gptCompat } from "./gpt";
import { preserveChineseOutputLanguage } from "./output-language";

/**
 * Tools whose successful result proves a file path exists in this task.
 * Successful apply_patch Add/Update operations prove the same and are
 * collected separately from the patch text.
 */
const KIMI_EXISTING_FILE_TOOLS = new Set([
  "fs.read_file",
  "code.outline",
  "code.ast_diff",
  "fs.write_file"
]);

function normalizeKimiPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase();
}

/**
 * Collects file paths that provably exist in this task: successfully read /
 * inspected / written files, plus paths touched by earlier successful
 * apply_patch Add or Update operations. Used to detect the recurring Kimi
 * failure where the model re-issues "*** Add File" for a file that already
 * exists (the tool then hard-fails preflight with "the file already exists").
 */
function collectKimiExistingFiles(transcript: ProviderTurnInput["transcript"]): Set<string> {
  const callsById = new Map<string, RuntimeToolCall>();
  const existing = new Set<string>();
  for (const message of transcript) {
    for (const call of message.toolCalls ?? []) {
      callsById.set(call.id, call);
    }
    if (message.role !== "tool" || message.toolResultOk !== true || !message.toolCallId) {
      continue;
    }
    const call = callsById.get(message.toolCallId);
    if (!call) {
      continue;
    }
    const filePath = typeof call.arguments.path === "string" ? call.arguments.path : null;
    if (filePath && KIMI_EXISTING_FILE_TOOLS.has(call.name)) {
      existing.add(normalizeKimiPath(filePath));
    }
    if (call.name === "apply_patch") {
      const patchText = typeof call.arguments.patch === "string" ? call.arguments.patch : "";
      for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) {
        existing.add(normalizeKimiPath(match[1]));
      }
    }
  }
  return existing;
}

/**
 * Best-effort cleanup of the patch text: strips a wrapping markdown fence and
 * any prose around it, and guarantees the *** Begin Patch / *** End Patch
 * markers the tool parser requires at the edges.
 */
function sanitizeKimiPatchText(raw: string): string | null {
  let text = raw.replace(/\r\n/g, "\n").trim();
  const fenced = text.match(/^```(?:patch|diff|text)?\s*\n([\s\S]*?)\n?```$/);
  if (fenced) {
    text = fenced[1].trim();
  }
  const beginIndex = text.indexOf("*** Begin Patch");
  if (beginIndex >= 0) {
    text = text.slice(beginIndex);
  } else if (/^\*\*\* (?:Add|Update|Delete) File: /m.test(text)) {
    text = `*** Begin Patch\n${text}`;
  } else {
    return null;
  }
  const endMarker = "*** End Patch";
  const endIndex = text.indexOf(endMarker);
  if (endIndex >= 0) {
    text = text.slice(0, endIndex + endMarker.length);
  } else {
    text = `${text.replace(/\s+$/, "")}\n${endMarker}`;
  }
  return text;
}

type KimiPatchSection = { kind: "add" | "update" | "delete"; file: string; text: string };

function splitKimiPatchSections(patch: string): KimiPatchSection[] | null {
  const begin = patch.indexOf("*** Begin Patch");
  const end = patch.indexOf("*** End Patch");
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  const body = patch.slice(begin + "*** Begin Patch".length, end);
  const headers = [...body.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)];
  if (headers.length === 0) {
    return null;
  }
  return headers.map((header, index) => ({
    kind: header[1].toLowerCase() as KimiPatchSection["kind"],
    file: header[2].trim(),
    text: body.slice(header.index, index + 1 < headers.length ? headers[index + 1].index : body.length).replace(/\n+$/, "")
  }));
}

/** Extracts file content from an Add File section (all "+" lines). */
function extractKimiAddFileContent(sectionText: string): string | null {
  const lines = sectionText.split("\n").slice(1);
  const contentLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("*** ")) {
      break;
    }
    if (!line.startsWith("+")) {
      return null;
    }
    contentLines.push(line.slice(1));
  }
  return contentLines.join("\n");
}

function normalizeKimiApplyPatchCall(
  toolCall: RuntimeToolCall,
  existingFiles: ReadonlySet<string>,
  availableTools: ReadonlySet<string>
): { calls: RuntimeToolCall[]; changed: boolean } {
  if (toolCall.name !== "apply_patch") {
    return { calls: [toolCall], changed: false };
  }
  const args = toolCall.arguments as Record<string, unknown>;
  const rawPatch = [args.patch, args.patch_content, args.patchText, args.content].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );

  if (!rawPatch) {
    // The model sent a full-file rewrite as {path, content}; fs.write_file
    // expresses that intent directly instead of a malformed patch.
    const filePath = typeof args.path === "string" ? args.path : null;
    const content = typeof args.content === "string" ? args.content : null;
    if (filePath && content !== null && availableTools.has("fs.write_file")) {
      return {
        calls: [{ ...toolCall, name: "fs.write_file", arguments: { path: filePath, content } }],
        changed: true
      };
    }
    return { calls: [toolCall], changed: false };
  }

  const sanitized = sanitizeKimiPatchText(rawPatch);
  if (!sanitized) {
    return { calls: [toolCall], changed: false };
  }
  const sections = splitKimiPatchSections(sanitized);
  if (!sections) {
    return sanitized === rawPatch && args.patch === rawPatch
      ? { calls: [toolCall], changed: false }
      : { calls: [{ ...toolCall, arguments: { patch: sanitized } }], changed: true };
  }

  const writeCalls: RuntimeToolCall[] = [];
  const keptSections: string[] = [];
  for (const section of sections) {
    // Kimi repeatedly re-issues "*** Add File" for files it created earlier in
    // the task; the tool hard-fails preflight because the file exists. The
    // Add content is the complete file by definition, so a verified-existing
    // path converts cleanly to an fs.write_file overwrite.
    if (section.kind === "add" && availableTools.has("fs.write_file") && existingFiles.has(normalizeKimiPath(section.file))) {
      const content = extractKimiAddFileContent(section.text);
      if (content !== null) {
        writeCalls.push({ ...toolCall, name: "fs.write_file", arguments: { path: section.file, content } });
        continue;
      }
    }
    keptSections.push(section.text);
  }

  const calls: RuntimeToolCall[] = [];
  if (keptSections.length > 0) {
    calls.push({
      ...toolCall,
      arguments: { patch: ["*** Begin Patch", ...keptSections, "*** End Patch"].join("\n") }
    });
  }
  calls.push(...writeCalls);
  return { calls, changed: true };
}

/**
 * Normalizes apply_patch decisions before execution. Kimi models otherwise
 * fail the tool's preflight in recurring ways: re-adding files that already
 * exist in the task (converted to fs.write_file overwrites), wrapping patches
 * in markdown fences or prose (stripped), omitting the Begin/End markers
 * (restored), and sending alternate argument shapes (path/content,
 * patch_content) that the tool does not accept.
 */
function normalizeKimiFileToolDecision(
  decision: ProviderTurnDecision,
  input: ProviderTurnInput
): ProviderTurnDecision {
  const existingFiles = collectKimiExistingFiles(input.transcript);
  const availableTools = new Set(input.availableTools.map((tool) => tool.name));
  let changed = false;
  const toolCalls = decision.toolCalls.flatMap((toolCall) => {
    const normalized = normalizeKimiApplyPatchCall(toolCall, existingFiles, availableTools);
    if (normalized.changed) {
      changed = true;
    }
    return normalized.calls;
  });
  return changed ? { ...decision, toolCalls } : decision;
}

/**
 * Kimi (Moonshot AI) openai-compatible shell.
 *
 * Reference: Moonshot AI platform docs
 * (https://platform.moonshot.ai/docs/api/chat, https://platform.moonshot.cn/docs/api/chat).
 *
 * Tuned:
 *  - `normalizeRequestParams`:
 *    * All Kimi models: strips `parallel_tool_calls`. The field is not part
 *      of the Moonshot chat schema, so sending it (even as `false`) fails
 *      validation with "400 Invalid request parameters". Parallel tool
 *      behaviour stays model-decided; the supportsParallelToolCalls profile
 *      flag only gates what the runtime asks for, not what the wire carries.
 *    * All Kimi models: clamps `temperature` into [0, 1]. Moonshot rejects
 *      out-of-range values with HTTP 400 (some models even pin temperature
 *      to exactly 1), while OpenAI-style profiles allow up to 2.
 *    * Thinking models (kimi-thinking-preview, k2-thinking, any display name
 *      with "thinking") reject sampling fields — temperature, top_p,
 *      frequency_penalty, presence_penalty, logprobs, top_logprobs — and
 *      response_format. They are stripped to avoid HTTP 400, mirroring the
 *      deepseek-reasoner treatment.
 *    * Preserves the model profile's `max_tokens` value. Output limits are
 *      model/provider configuration, not a compatibility-layer default.
 *    * Repairs the message sequence (code 11133, replay-verified):
 *      - assistant `content: null` is rejected; it becomes "".
 *      - adjacent ordinary assistant/user messages are coalesced; runtime
 *        progress updates otherwise produce a role run Moonshot rejects.
 *      - tool results are moved to immediately follow their assistant
 *        tool_calls message. The runtime records streamed commentary as
 *        separate assistant messages between a tool_calls message and its
 *        tool results, and the gateway's strict pairing validator rejects
 *        that interleaving. Results lost to an interrupted turn are
 *        synthesized as placeholders so resumed turns stay valid.
 *      - orphan tool results (their call belongs to an interrupted or
 *        compacted turn no longer in the history) are demoted to user
 *        messages, keeping the content as context instead of failing the
 *        request.
 *    * Appends the shared Chinese-output reminder when the conversation is
 *      Chinese, so English system prompts and tool output do not pull Kimi
 *      into replying in English.
 *  - `extractVisibleStreamText`: kimi-k2 runs in native-tool-call mode
 *    (supportsToolCalling=true), so `content` is a natural-language reply,
 *    NOT a JSON decision envelope. The GPT baseline suppresses buffers that
 *    start with `{` or `<`, which would swallow Kimi's code blocks / JSON
 *    outputs. Only route to the GPT envelope extractor when the buffer
 *    actually looks like an envelope (`"assistant_message"` substring);
 *    otherwise return the accumulated text verbatim.
 *
 * Inherited from GPT baseline (verified matching Moonshot docs):
 *  - `extractReasoningFromDelta`/`extractReasoningFromMessage`: Kimi thinking
 *    models surface chain-of-thought via reasoning_content (stream
 *    delta.reasoning_content / non-stream message.reasoning_content), the
 *    exact field path the baseline already reads.
 *  - tool_calls / JSON output: kimi-k2 follows the OpenAI native
 *    function-calling shape (tools array + tool_call_id round trips), and
 *    response_format json_object is supported on non-thinking models.
 *
 * Changes in this file never affect deepseek/grok/glm/qwen/sensenova/gpt.
 */
/**
 * Normalizes the wire message sequence for Moonshot's strict validator:
 *  - assistant `content: null` becomes "" (null is rejected, code 11133);
 *  - every tool result is moved to immediately follow its assistant
 *    tool_calls message — streamed commentary recorded as separate assistant
 *    messages in between breaks the pairing and is rejected;
 *  - results missing entirely (turn interrupted mid-execution, then resumed)
 *    are synthesized as placeholders so the history stays valid.
 */
function repairKimiMessages(messages: unknown[]): unknown[] {
  type WireMessage = {
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: unknown;
  };
  const list = messages as WireMessage[];
  const consumed = new Set<number>();
  const out: WireMessage[] = [];
  for (let i = 0; i < list.length; i += 1) {
    if (consumed.has(i)) {
      continue;
    }
    consumed.add(i);
    const message = list[i];

    // Orphan tool result: no earlier assistant tool_calls claimed it (its
    // call belongs to an interrupted/compacted turn that is no longer in the
    // history). A bare tool message without a matching call fails the
    // gateway's strict pairing validation (code 11133), so it is demoted to
    // a user message, keeping the content available as context.
    if (message && message.role === "tool") {
      out.push({
        role: "user",
        content: `(earlier tool result without a matching tool call: ${String(message.tool_call_id ?? "unknown")})\n${
          typeof message.content === "string" ? message.content : ""
        }`
      });
      continue;
    }

    const normalized =
      message && message.role === "assistant" && (message.content === null || message.content === undefined)
        ? { ...message, content: "" }
        : message;
    out.push(normalized);

    const toolCalls =
      normalized && Array.isArray(normalized.tool_calls)
        ? (normalized.tool_calls as Array<{ id?: unknown }>)
        : null;
    if (!toolCalls || toolCalls.length === 0) {
      continue;
    }
    for (const call of toolCalls) {
      const callId = call && typeof call.id === "string" ? call.id : null;
      if (!callId) {
        continue;
      }
      let found = false;
      for (let j = i + 1; j < list.length; j += 1) {
        if (consumed.has(j)) {
          continue;
        }
        const candidate = list[j];
        if (candidate && candidate.role === "tool" && candidate.tool_call_id === callId) {
          consumed.add(j);
          out.push(candidate);
          found = true;
          break;
        }
      }
      if (!found) {
        out.push({
          role: "tool",
          tool_call_id: callId,
          content: "(tool result unavailable: execution was interrupted before the result was recorded)"
        });
      }
    }
  }
  return coalesceKimiMessages(out);
}

function isKimiK3(model: Pick<ModelProfile, "id" | "displayName">): boolean {
  const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
  return /(?:^|[\s_-])(?:kimi[\s_-]?)?k3(?:$|[\s_-])/.test(identity);
}

/**
 * Moonshot validates chat history more strictly than the OpenAI API and
 * rejects runs of same-role messages (the runtime can record several
 * assistant progress updates before the next user turn). Merge only ordinary
 * text/content messages; tool-call assistant messages and tool results must
 * remain separate so their pairing stays explicit.
 */
function coalesceKimiMessages(messages: unknown[]): unknown[] {
  type MergeableMessage = {
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
  };
  const out: MergeableMessage[] = [];
  for (const message of messages as MergeableMessage[]) {
    const previous = out[out.length - 1];
    const role = message?.role;
    const canMergeRole = role === "assistant" || role === "user";
    const canMergeText =
      canMergeRole &&
      previous?.role === role &&
      !Array.isArray(previous.tool_calls) &&
      !Array.isArray(message.tool_calls);
    // A progress message can also directly precede the assistant tool-call
    // message that follows it. Chat APIs permit text alongside tool_calls, so
    // fold that text into the call message to remove the invalid role run.
    const canMergeIntoToolCall =
      role === "assistant" &&
      previous?.role === "assistant" &&
      !Array.isArray(previous.tool_calls) &&
      Array.isArray(message.tool_calls);
    if (canMergeIntoToolCall) {
      message.content = mergeKimiMessageContent(previous.content, message.content);
      out[out.length - 1] = message;
      continue;
    }
    if (!canMergeText) {
      out.push(message);
      continue;
    }

    previous.content = mergeKimiMessageContent(previous.content, message.content);
  }
  return out;
}

function mergeKimiMessageContent(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) {
    return [...left, ...right];
  } else if (Array.isArray(left) && typeof right === "string") {
    return [...left, { type: "text", text: right }];
  } else if (typeof left === "string" && Array.isArray(right)) {
    return [{ type: "text", text: left }, ...right];
  } else if (typeof left === "string" && typeof right === "string") {
    return left && right ? `${left}\n\n${right}` : left || right;
  } else if (right !== undefined && right !== null) {
    return left === undefined || left === null ? right : `${String(left)}\n\n${String(right)}`;
  }
  return left;
}

export const kimiCompat = defineCompat(gptCompat, {
  id: "kimi",
  keywords: ["kimi", "moonshot"],
  shouldBypassStandardCompletionAudit(model): boolean {
    // Kimi K3 can leave a no-tool, non-streaming audit call open after the
    // visible final reply has already been generated. Deterministic runtime
    // validation still verifies delivery and post-change evidence first.
    return isKimiK3(model);
  },
  normalizeRequestParams(
    ctx: ModelCompatContext,
    base: Record<string, unknown>
  ): Record<string, unknown> {
    const identity = `${ctx.model.id} ${ctx.model.displayName ?? ""}`.toLowerCase();
    const isThinking = /thinking/.test(identity);

    // 1. All Kimi models: strip parallel_tool_calls. It is absent from the
    //    Moonshot chat schema, so the strict validator fails the request with
    //    "400 Invalid request parameters" whenever the field is present —
    //    including parallel_tool_calls: false, which the provider attaches
    //    unconditionally when tools are declared.
    const { parallel_tool_calls, ...restBase } = base as Record<string, unknown> & {
      parallel_tool_calls?: unknown;
    };
    let next: Record<string, unknown> = restBase;

    // 2. All Kimi models: Moonshot only accepts temperature within [0, 1]
    //    (OpenAI allows up to 2, and some Kimi models pin it to exactly 1).
    //    Clamp out-of-range profile defaults instead of failing with 400.
    if (typeof next.temperature === "number") {
      const clampedTemperature = Math.min(1, Math.max(0, next.temperature));
      if (clampedTemperature !== next.temperature) {
        next = { ...next, temperature: clampedTemperature };
      }
    }

    // 3. Thinking models: strip fields the thinking API rejects (HTTP 400).
    if (isThinking) {
      const {
        temperature,
        top_p,
        frequency_penalty,
        presence_penalty,
        logprobs,
        top_logprobs,
        response_format,
        ...rest
      } = next as Record<string, unknown> & {
        temperature?: unknown;
        top_p?: unknown;
        frequency_penalty?: unknown;
        presence_penalty?: unknown;
        logprobs?: unknown;
        top_logprobs?: unknown;
        response_format?: unknown;
      };
      next = rest;
    }

    // 4. Repair the message sequence: null assistant content and tool
    //    results separated from their tool_calls message both fail the
    //    gateway's strict validation with code 11133. Coalescing ordinary
    //    same-role messages also prevents consecutive assistant progress
    //    updates from being rejected as an invalid chat sequence.
    if (Array.isArray(next.messages)) {
      next = { ...next, messages: repairKimiMessages(next.messages) };
    }
    return preserveChineseOutputLanguage(ctx, next);
  },
  extractVisibleStreamText(accumulated: string): string {
    // Only apply the GPT envelope extractor when the buffer really is a
    // decision envelope; otherwise pass content through verbatim so Kimi's
    // native-tool-call replies (including code/JSON blocks starting with `{`)
    // are not swallowed.
    if (accumulated.includes('"assistant_message"')) {
      return gptCompat.extractVisibleStreamText(accumulated);
    }
    // Surface inline <think> reasoning in the streaming draft so users can
    // watch the think process; final parsing still strips it.
    return surfaceThinkBlocksInStream(accumulated);
  }
});
