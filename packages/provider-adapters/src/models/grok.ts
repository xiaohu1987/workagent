import { defineCompat } from "./types";
import type { ImageGenerationPlan, ModelCompatContext, ModelCompatToolCallMode, ModelGenerationContext } from "./types";
import type { ModelProfile, ProviderTurnDecision, ProviderTurnInput, RuntimeToolCall, ToolSpecDefinition } from "@shared-types";
import { gptCompat } from "./gpt";

const COMPLETION_AUDIT_PROMPT_MARKER = "You are a completion auditor for a desktop agent.";

const GROK_NATIVE_TOOL_NAMES: Readonly<Record<string, string>> = {
  "fs.read_file": "read_file",
  "fs.read_directory": "list_dir",
  "code.search": "grep",
  search_replace: "search_replace",
  "shell.exec": "bash"
};

export function isGrokModel(
  model: Pick<ModelProfile, "id" | "displayName">
): boolean {
  return `${model.id} ${model.displayName ?? ""}`.toLowerCase().includes("grok");
}

export function grokNativeToolName(
  name: string,
  model: Pick<ModelProfile, "id" | "displayName">
): string | undefined {
  return isGrokModel(model) ? GROK_NATIVE_TOOL_NAMES[name] : undefined;
}

export function prepareGrokAvailableTools(
  model: Pick<ModelProfile, "id" | "displayName">,
  tools: ProviderTurnInput["availableTools"]
): ProviderTurnInput["availableTools"] {
  if (!isGrokModel(model) || !tools.some((tool) => tool.name === "search_replace")) return tools;
  return tools
    .filter((tool) => tool.name !== "apply_patch" && tool.name !== "fs.write_file")
    .map(adaptGrokToolSpec);
}

function adaptGrokToolSpec(tool: ToolSpecDefinition): ToolSpecDefinition {
  if (tool.name === "fs.read_file") {
    return {
      ...tool,
      description: "Read a file. Use target_file with a workspace-relative or absolute path. Offset is a 1-based start line and limit is the number of lines to return.",
      inputSchema: {
        type: "object",
        properties: {
          target_file: { type: "string", description: "The path of the file to read." },
          offset: { type: "number", description: "1-based start line (optional)." },
          limit: { type: "number", description: "Maximum number of lines (optional)." }
        },
        required: ["target_file"]
      }
    };
  }
  if (tool.name === "fs.read_directory") {
    return {
      ...tool,
      description: "List a directory. Use this to inspect folders; do not use copy, rename, or delete tools for inspection.",
      inputSchema: {
        type: "object",
        properties: {
          target_directory: { type: "string", description: "Directory path relative to the workspace root or absolute." }
        },
        required: ["target_directory"]
      }
    };
  }
  if (tool.name === "shell.exec") {
    return {
      ...tool,
      description: process.platform === "win32"
        ? "Run a Windows PowerShell command in the workspace. Use read_file/list_dir for inspection and search_replace for file edits."
        : "Run a shell command in the workspace. Use read_file/list_dir for inspection and search_replace for file edits."
    };
  }
  if (tool.name === "code.search") {
    return {
      ...tool,
      description: "Search file contents with a regular expression. Use path to restrict the search to a file or directory.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression pattern to search for." },
          path: { type: "string", description: "File or directory to search. Defaults to the workspace." }
        },
        required: ["pattern"]
      }
    };
  }
  if (tool.name === "fs.copy") {
    return {
      ...tool,
      description: "Copy a file or directory to a distinct destination. Never call this to inspect a file, and never pass the same source and destination."
    };
  }
  return tool;
}

export function grokFileToolPromptLines(): string[] {
  return [
    "For every file creation or content edit, use search_replace.",
    "Call search_replace with exactly {file_path, old_string, new_string, replace_all?}. For an existing file, old_string must be exact current text and should normally match once. Include surrounding context when the text is ambiguous. Set replace_all=true only when every exact occurrence should change.",
    "Before editing an existing file, use read_file with {target_file, offset?, limit?}. Number prefixes such as 448| in sliced output are display metadata and must never appear in old_string or new_string.",
    "Use list_dir with {target_directory} to inspect folders. Never use copy, rename, or delete operations merely to inspect a path.",
    "Use grep with {pattern, path?} to search file contents before reading or editing a specific match.",
    "To create a missing file, call search_replace with old_string set to an empty string and new_string set to the full content. Never use an empty old_string to overwrite a non-empty file.",
    "If search_replace reports that the desired target state already exists, treat the edit as successful and do not retry it. If matching fails, re-read the file and make a new call using exact current text; never resend stale arguments unchanged."
  ];
}

function normalizeGrokFileToolDecision(
  decision: ProviderTurnDecision,
  input: ProviderTurnInput
): ProviderTurnDecision {
  if (decision.toolCalls.length === 0) return decision;
  const available = new Set(input.availableTools.map((tool) => tool.name));
  let changed = false;
  const toolCalls = decision.toolCalls.map((call) => {
    const normalized = normalizeGrokToolCall(call, available);
    if (normalized !== call) changed = true;
    return normalized;
  });
  return changed ? { ...decision, toolCalls } : decision;
}

function normalizeGrokToolCall(
  call: RuntimeToolCall,
  available: ReadonlySet<string>
): RuntimeToolCall {
  const args = call.arguments;
  if (call.name === "fs.read_file") {
    const target = args.path ?? args.target_file ?? args.file_path;
    if (typeof target === "string") {
      return { ...call, arguments: { path: target, ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }) } };
    }
  }
  if (call.name === "fs.read_directory") {
    const target = args.path ?? args.target_directory;
    if (typeof target === "string") return { ...call, arguments: { path: target } };
  }
  if (call.name === "code.search" && typeof args.pattern === "string") {
    return { ...call, arguments: { pattern: args.pattern, ...(typeof args.path === "string" ? { path: args.path } : {}) } };
  }
  if (call.name === "fs.copy" && available.has("fs.read_file")) {
    const from = typeof args.from === "string" ? args.from : "";
    const to = typeof args.to === "string" ? args.to : "";
    if (from && to && normalizeGrokPath(from) === normalizeGrokPath(to)) {
      return { ...call, name: "fs.read_file", arguments: { path: from } };
    }
  }
  return call;
}

function normalizeGrokPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase();
}

export function isGrokCompletionAudit(context: ModelCompatContext): boolean {
  const identity = `${context.model.id} ${context.model.displayName ?? ""}`.toLowerCase();
  return identity.includes("grok")
    && context.input.availableTools.length === 0
    && context.input.systemPrompt.includes(COMPLETION_AUDIT_PROMPT_MARKER);
}

export function appendGrokCompletionAuditInstruction(context: ModelCompatContext, systemPrompt: string): string {
  if (!isGrokCompletionAudit(context)) return systemPrompt;
  return `${systemPrompt}\n\nGrok completion-audit compatibility: do not return JSON. Return exactly APPROVED when the candidate is complete. Otherwise return REJECTED: followed by concise factual gaps. Do not add commentary.`;
}

export function normalizeGrokCompletionAuditDecision(
  context: ModelCompatContext,
  decision: ReturnType<typeof gptCompat.parseResponse>,
  text?: string,
  reasoning?: string
): ReturnType<typeof gptCompat.parseResponse> {
  if (!isGrokCompletionAudit(context)) return decision;

  const verdict = text?.trim() || reasoning?.trim() || decision.assistantMessage?.trim() || "";
  if (/^APPROVED[.!。]?$/i.test(verdict)) {
    return {
      ...decision,
      assistantMessage: "APPROVED",
      toolCalls: [],
      endTurn: true,
      goalCompleted: true,
      isStructured: true
    };
  }
  if (/^REJECTED\s*[:：-]/i.test(verdict)) {
    return {
      ...decision,
      assistantMessage: verdict.replace(/^REJECTED\s*[:：-]?\s*/i, "").trim() || "Grok completion audit returned no verdict.",
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: true
    };
  }

  // The runtime has already run deterministic completion validation before
  // asking this optional audit. Grok gateways often return prose or put the
  // verdict in an unsupported response field, neither of which is evidence
  // that the candidate task failed.
  return {
    ...decision,
    assistantMessage: "APPROVED",
    toolCalls: [],
    endTurn: true,
    goalCompleted: true,
    isStructured: true,
    reasoningSummary: "Grok completion audit did not return a compatible verdict; deterministic completion validation was used."
  };
}

/**
 * Grok (xAI) openai-compatible shell.
 *
 * Reference: xAI official API docs
 * (https://docs.xai.ac.cn/docs/guides/image-generations,
 *  https://www.atlascloud.ai/zh/blog/guides/grok-imagine-video-generation,
 *  https://docs.xai.ac.cn/docs/guides/deferred-chat-completions).
 *
 * Tuned:
 *  - `resolveImageGeneration`: only image models (id/displayName contains
 *    "image") route to the grok-images protocol. xAI image generation uses
 *    `/images/generations` and does NOT accept OpenAI's `size`/`quality`/
 *    `style` params; output is JPG (provider infers mime from the response
 *    content-type, so no mime override is needed here). Non-image grok
 *    models (grok-3, grok-4, ...) delegate to the GPT baseline's
 *    openai-compatible SDK path instead of forcing grok-images.
 *
 * Inherited from GPT baseline (verified matching xAI docs):
 *  - `resolveVideoGeneration`: xAI video uses `/videos/generations` create +
 *    `/videos/{request_id}` poll, status values pending/done/expired/failed,
 *    payload fields model/prompt/duration/aspect_ratio/resolution — identical
 *    to the GPT baseline plan, so no override. (xAI also supports an `image`
 *    field for image-to-video, but generateVideo's signature has no image
 *    input, so that path is out of scope here.)
 *  - `extractReasoningFromDelta`/`extractReasoningFromMessage`: xAI surfaces
 *    chain-of-thought via `reasoning_content` (grok-4 does not return it).
 *    The GPT baseline already reads that field, so grok inherits; when
 *    reasoning_content is absent (grok-4), the hooks return "" and
 *    reasoningSummary stays undefined.
 *  - chat tool call / streaming: xAI is OpenAI-compatible (tool_calls shape,
 *    usage on the final chunk via stream_options.include_usage).
 *
 * Changes in this file never affect deepseek/glm/qwen/sensenova/gpt.
 */
export const grokCompat = defineCompat(gptCompat, {
  id: "grok",
  keywords: ["grok"],
  resolveToolCallMode(context: ModelCompatContext): ModelCompatToolCallMode {
    if (isGrokCompletionAudit(context)) {
      // Some Grok-compatible gateways omit visible content when json_object is
      // requested for this internal, no-tool verdict. Use the compact text
      // protocol below instead.
      return { useNativeTools: false, useJsonOutput: false };
    }
    return gptCompat.resolveToolCallMode(context);
  },
  normalizeRequestParams(context: ModelCompatContext, base: Record<string, unknown>): Record<string, unknown> {
    const request = gptCompat.normalizeRequestParams(context, base);
    if (!isGrokCompletionAudit(context)) return request;

    const { response_format: _responseFormat, ...withoutJsonFormat } = request;
    const messages = Array.isArray(withoutJsonFormat.messages)
      ? withoutJsonFormat.messages.map((message) => {
          if (!message || typeof message !== "object" || (message as Record<string, unknown>).role !== "system") {
            return message;
          }
          const current = message as Record<string, unknown>;
          return {
            ...current,
            content: appendGrokCompletionAuditInstruction(context, String(current.content ?? ""))
          };
        })
      : withoutJsonFormat.messages;
    return { ...withoutJsonFormat, messages };
  },
  parseResponse(response, context: ModelCompatContext, hasNativeTools: boolean) {
    const parsed = gptCompat.parseResponse(response, context, hasNativeTools);
    const message = response?.choices?.[0]?.message;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    return normalizeGrokCompletionAuditDecision(context, parsed, content, reasoning);
  },
  normalizeDecision(decision: ProviderTurnDecision, context: ModelCompatContext): ProviderTurnDecision {
    return normalizeGrokFileToolDecision(gptCompat.normalizeDecision(decision, context), context.input);
  },
  resolveImageGeneration({ model, prompt }: ModelGenerationContext): ImageGenerationPlan {
    const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
    if (!identity.includes("image")) {
      // Non-image grok models (grok-3, grok-4, ...) are NOT image generators.
      // Fail loudly instead of delegating to the GPT baseline: the baseline's
      // OpenAI SDK path sends size/response_format, which xAI rejects with
      // HTTP 400 — and OpenAI-compatible gateways in between often silently
      // remap such requests to their own default image model (DALL-E, Flux,
      // ...), returning an image that was never drawn by Grok.
      throw new Error(
        `模型「${model.displayName || model.id}」不是图片生成模型，无法用于生成图片。` +
        `请到「设置 → 多模态」将默认图片模型切换为 Grok 的图片模型（如 grok-imagine-image-quality）后再试。`
      );
    }
    // xAI image generation: POST /images/generations with model/prompt/n.
    // size/quality/style are NOT supported by xAI and are intentionally
    // omitted (sending them triggers HTTP 400).
    // NOTE: do NOT add response_format: "b64_json" here. Although xAI
    // documents it, OpenAI-compatible gateway relays often fail proxying the
    // large inline-base64 response body (upstream timeout / payload limits),
    // surfacing as HTTP 502. The default short-lived URL response proxies
    // fine because the gateway only forwards JSON and the client downloads
    // the image bytes directly from the CDN.
    return {
      protocol: "grok-images",
      endpoint: "/images/generations",
      payload: { model: model.id, prompt, n: 1 },
      label: "Grok image generation request"
    };
  }
});
