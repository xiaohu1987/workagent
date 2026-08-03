import type { ArtifactRecord, AssistantDraftPhase, ContextCompactionRecord, GpaStage, GpaState, MessageAttachment, MessageRecord, RuntimeThreadSnapshot, ThreadRecord, ToolCallRecord, UserInputPrompt } from "@shared-types";
import { isThreadExecutionInProgress } from "../core/thread-ui-state";
import { FileSnapshot } from "./project-files";

export type ComposerAttachment =
  | { id: string; kind: "file" | "folder" | "image"; path: string; label: string; file?: File; previewUrl?: string; entries?: string[]; entriesTruncated?: boolean }
  | { id: string; kind: "code"; path: string; content: string; label: string; intent: "reference" | "edit" }
  | { id: string; kind: "skill"; skillId: string; label: string; description: string }
  | { id: string; kind: "mcp"; serverId: string; label: string; description: string }
  | { id: string; kind: "database"; connectionId: string; label: string; description: string };

export type ComposerAttachmentInput =
  | { kind: "file" | "folder" | "image"; path: string; label: string; file?: File; previewUrl?: string; entries?: string[]; entriesTruncated?: boolean }
  | { kind: "code"; path: string; content: string; label: string; intent: "reference" | "edit" }
  | { kind: "skill"; skillId: string; label: string; description: string }
  | { kind: "mcp"; serverId: string; label: string; description: string }
  | { kind: "database"; connectionId: string; label: string; description: string };

export type ComposerBinaryAttachment = {
  id: string;
  kind: "file" | "image";
  path: string;
  label: string;
  file?: File;
  previewUrl?: string;
};

export function isPersistentComposerContextKind(_kind: string): boolean {
  // Composer chips above the input are always one-shot: clear after send.
  return false;
}

export function retainPersistentComposerContexts<T extends { kind: string }>(_attachments: T[]): T[] {
  return [];
}

export type ContextUsageSegment = {
  id: string;
  label: string;
  tokens: number;
  color: string;
};

export type ContextUsage = {
  contextWindow: number;
  usedTokens: number;
  percentage: number;
  segments: ContextUsageSegment[];
  compaction: ContextCompactionRecord | null;
};

export function composerAttachmentKey(attachment: ComposerAttachment | ComposerAttachmentInput): string {
  switch (attachment.kind) {
    case "code":
      return `${attachment.kind}:${attachment.path}:${attachment.content}`;
    case "skill":
      return `${attachment.kind}:${attachment.skillId}`;
    case "mcp":
      return `${attachment.kind}:${attachment.serverId}`;
    case "database":
      return `${attachment.kind}:${attachment.connectionId}`;
    default:
      // Clipboard images do not have a filesystem path. Include their data URL so
      // separately pasted screenshots are not incorrectly collapsed into one item.
      if (attachment.path) return `${attachment.kind}:${attachment.path}`;
      if (attachment.file) {
        return `${attachment.kind}:${attachment.file.name}:${attachment.file.size}:${attachment.file.lastModified}:${attachment.previewUrl ?? ""}`;
      }
      return `${attachment.kind}:${attachment.label}`;
  }
}

export type ChatEventType =
  | "commentary"
  | "tool_call"
  | "tool_result"
  | "file_view"
  | "file_change"
  | "test_result"
  | "final";

export type ChatEventBlock = {
  type: ChatEventType;
  title?: string;
  content: string;
  name?: string;
  status?: string;
  path?: string;
  action?: string;
  startLine?: number;
  durationMs?: number;
  exitCode?: number;
  ok?: boolean;
};

export type TimelineEntry =
  | { kind: "message"; id: string; createdAt: string; message: MessageRecord }
  | { kind: "tool-group"; id: string; createdAt: string; toolCalls: ToolCallRecord[] }
  | { kind: "file-summary"; id: string; createdAt: string; files: FileChangeSummaryItem[] }
  | { kind: "directory-read-group"; id: string; createdAt: string; directory: string; count: number }
  | { kind: "context-compaction"; id: string; createdAt: string; compaction: ContextCompactionRecord }
  | { kind: "user-input"; id: string; createdAt: string; prompt: UserInputPrompt };

export type ConversationTurnSection = {
  id: string;
  userEntryId: string;
  summaryEntryId: string | null;
  entryIds: string[];
  startedAt: string;
  completedAt: string;
};

export type FileChangeAction = "created" | "modified" | "deleted";

export type FileChangeSummaryItem = {
  path: string;
  absolutePath?: string;
  action: FileChangeAction;
  additions: number;
  deletions: number;
  kind?: "generated-image" | "generated-video" | "generated-file" | "patch";
  description?: string;
  symbols?: Array<{ name: string; kind: string; change: string }>;
  snapshot?: FileSnapshot;
};

export type ConversationTurnItem = {
  id: string;
  content: string;
  createdAt: string;
  files: FileChangeSummaryItem[];
};

export type AssistantDraft = {
  draftId: string;
  sequence: number;
  threadId: string;
  turnRunId: string;
  content: string;
  phase: AssistantDraftPhase;
  startedAt: string;
  completed: boolean;
  messageId?: string;
};

export type ActiveToolCall = {
  threadId: string;
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
};

export function formatComposerAttachments(attachments: ComposerAttachment[]): string {
  return attachments
    .map((attachment) => {
      if (attachment.kind === "code") {
        const instruction = attachment.intent === "edit" ? "Edit the following selected code" : "Reference the following selected code";
        return `${instruction} from ${attachment.path}:\n\`\`\`\n${attachment.content}\n\`\`\``;
      }
      if (attachment.kind === "skill") {
        return `[Selected Skill]\n${attachment.label}: ${attachment.description}`;
      }
      if (attachment.kind === "mcp") {
        return [
          "[Selected MCP server]",
          `id: ${attachment.serverId}`,
          `${attachment.label}: ${attachment.description}`,
          "This request requires querying this MCP server before answering."
        ].join("\n");
      }
      if (attachment.kind === "database") {
        return ["[Selected database]", `id: ${attachment.connectionId}`, `${attachment.label}: ${attachment.description}`, "Use only this selected database source for this request when database access is needed."].join("\n");
      }
      if (attachment.kind === "image") {
        return `[Attached image]\n${attachment.path}\nUse the image attachment as visual reference when the selected model supports image input.`;
      }
      if (attachment.kind === "folder") {
        const manifest = attachment.entries?.length
          ? [
              `Directory tree (${attachment.entries.length}${attachment.entriesTruncated ? "+" : ""} entries):`,
              ...attachment.entries.map((entry) => `- ${entry}`)
            ].join("\n")
          : "Directory tree was not preloaded.";
        return [
          "[Attached folder - required task context]",
          `path: ${attachment.path}`,
          manifest,
          "Inspect this folder before answering. Use fs.read_directory on the exact path, then use fs.read_file for the files relevant to the request. Do not claim the folder was inspected until those tool calls succeed."
        ].join("\n");
      }
      return `[Attached file]\n${attachment.path}`;
    })
    .join("\n\n");
}

export function buildContextUsage(input: {
  contextWindow: number;
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  gpaStage: GpaStage;
  selectedSkillCount: number;
  mcpServerCount: number;
  pendingInput: string;
  compaction?: ContextCompactionRecord | null;
}): ContextUsage {
  const fixedSegments: ContextUsageSegment[] = [
    { id: "system", label: "系统提示", tokens: 1_200, color: "#a8a8a8" },
    { id: "tools", label: "工具定义", tokens: 900 + input.mcpServerCount * 240, color: "#9988ef" },
    { id: "rules", label: "规则", tokens: input.gpaStage === "off" ? 240 : 980, color: "#4fba7b" },
    { id: "skills", label: "技能", tokens: input.selectedSkillCount * 520, color: "#efb35c" },
    { id: "mcp", label: "MCP 与动态工具", tokens: input.mcpServerCount * 360, color: "#bf98bd" }
  ];
  const fixedTokens = fixedSegments.reduce((total, segment) => total + segment.tokens, 0);
  const compactedAt = input.compaction ? Date.parse(input.compaction.createdAt) : Number.NaN;
  const conversationText = input.compaction
    ? [
        ...input.messages
          .filter((message) => Date.parse(message.createdAt) > compactedAt)
          .map((message) => message.content),
        ...input.toolCalls
          .filter((toolCall) => Date.parse(toolCall.completedAt ?? toolCall.startedAt) > compactedAt)
          .map((toolCall) => toolCall.argumentsJson),
        input.pendingInput
      ].join("\n")
    : [
        ...input.messages.map((message) => message.content),
        ...input.toolCalls.map((toolCall) => toolCall.argumentsJson),
        input.pendingInput
      ].join("\n");
  const recentTokens = Math.max(0, estimateContextTokens(conversationText));
  const conversationTokens = input.compaction
    ? Math.max(1, input.compaction.afterTokens - fixedTokens) + recentTokens
    : Math.max(1, recentTokens);
  const segments: ContextUsageSegment[] = [
    ...fixedSegments,
    {
      id: "conversation",
      label: input.compaction ? "压缩后的对话与工具结果" : "对话与工具结果",
      tokens: conversationTokens,
      color: "#e28b85"
    }
  ];
  const usedTokens = segments.reduce((total, segment) => total + segment.tokens, 0);
  const contextWindow = Math.max(1, input.contextWindow);
  return {
    contextWindow,
    usedTokens,
    percentage: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
    segments,
    compaction: input.compaction ?? null
  };
}

export function estimateContextTokens(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }
  return Math.ceil(Array.from(normalized).length / 2.8);
}

export function formatMessageAttachments(attachments: MessageAttachment[]): string {
  return attachments
    .map((attachment) => attachment.kind === "image"
      ? `[Attached image]\n${attachment.name}\nUse this image as visual reference.`
      : `[Attached file]\n${attachment.absolutePath}`)
    .join("\n\n");
}

export function shouldShowRuntimeActivityPanel(
  isTaskProcessing: boolean
): boolean {
  // Runtime entries are display history, not an execution source of truth.
  // The persisted thread state determines whether the live heartbeat is visible.
  return isTaskProcessing;
}

export function buildTimelineEntries(
  messages: MessageRecord[],
  toolCalls: ToolCallRecord[],
  artifacts: ArtifactRecord[],
  workspaceRoot?: string | null,
  threadStatus?: ThreadRecord["status"] | null,
  prompts: UserInputPrompt[] = [],
  contextCompaction: ContextCompactionRecord | null = null
): TimelineEntry[] {
  const filesByTurn = collectFileChangesByTurn(toolCalls, workspaceRoot);
  for (const artifact of artifacts) {
    if (
      artifact.artifactKind !== "generated-image" &&
      artifact.artifactKind !== "generated-video" &&
      artifact.artifactKind !== "browser-screenshot" &&
      artifact.artifactKind !== "browser-snapshot" &&
      artifact.artifactKind !== "knowledge-index"
    ) {
      continue;
    }
    const turnRunId = artifact.turnRunId ?? `artifact-${artifact.id}`;
    const isVideo = artifact.artifactKind === "generated-video";
    const isImage = artifact.artifactKind === "generated-image" || artifact.artifactKind === "browser-screenshot";
    filesByTurn.set(turnRunId, [
      ...(filesByTurn.get(turnRunId) ?? []),
      {
        path: artifact.relativePath ?? artifact.displayName,
        absolutePath: artifact.absolutePath,
        action: "created",
        additions: 0,
        deletions: 0,
        kind: isVideo ? "generated-video" : isImage ? "generated-image" : "generated-file",
        description: getGeneratedFileDescription(
          artifact.relativePath ?? artifact.displayName,
          isVideo ? "generated-video" : isImage ? "generated-image" : "generated-file",
          artifact.artifactKind
        )
      }
    ]);
  }
  const messageEntries: TimelineEntry[] = [];

  for (const message of messages) {
    if (
      message.role === "tool" ||
      getMessageDisplayKind(message) === "tool_batch" ||
      isPatchAssistantMessage(message.content) ||
      (message.role === "assistant" && isInternalAgentProtocolMessage(message.content))
    ) {
      continue;
    }

    messageEntries.push({
      kind: "message",
      id: `message-${message.id}`,
      createdAt: message.createdAt,
      message
    });

  }

  const toolEntries = buildToolGroupTimelineEntries(toolCalls, messages);

  // While a thread is running, only suppress the in-progress turn's file summary.
  // Prior turns' "主要改动文件" must stay visible.
  const activeTurnRunId = isThreadExecutionInProgress(threadStatus ?? null)
    ? [...messages].reverse().find((message) => message.turnRunId)?.turnRunId ?? null
    : null;
  const fileSummaryEntries: TimelineEntry[] = [...filesByTurn.entries()]
    .filter(([turnRunId]) => !(activeTurnRunId && turnRunId === activeTurnRunId))
    .map(([turnRunId, files]) => ({
      kind: "file-summary",
      id: `file-summary-${turnRunId}`,
      createdAt: getTurnSummaryCreatedAt(turnRunId, messages, toolCalls, artifacts),
      files
    }));
  const promptEntries: TimelineEntry[] = prompts.map((prompt) => ({
    kind: "user-input",
    id: `user-input-${prompt.id}`,
    createdAt: prompt.answeredAt ?? prompt.createdAt,
    prompt
  }));
  const contextCompactionEntries: TimelineEntry[] = contextCompaction ? [{
    kind: "context-compaction",
    id: `context-compaction-${contextCompaction.turnRunId}-${contextCompaction.createdAt}`,
    createdAt: contextCompaction.createdAt,
    compaction: contextCompaction
  }] : [];
  // Tool groups with commentary metadata share the preamble timestamp. Put
  // messages first so stable sorting yields "message -> tools" for each step.
  const sortedEntries = [...messageEntries, ...toolEntries, ...fileSummaryEntries, ...promptEntries, ...contextCompactionEntries].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
  );
  return collapseDirectoryReadMessages(sortedEntries);
}

export function buildConversationTurnSections(entries: TimelineEntry[]): ConversationTurnSection[] {
  const sections: ConversationTurnSection[] = [];
  let current: (ConversationTurnSection & {
    lastFormalAssistantEntryId: string | null;
  }) | null = null;

  const finishCurrent = () => {
    if (!current) return;
    const { lastFormalAssistantEntryId, ...section } = current;
    sections.push({
      ...section,
      summaryEntryId: lastFormalAssistantEntryId
    });
  };

  for (const entry of entries) {
    const isGuidance = entry.kind === "message" && getMessageDisplayKind(entry.message) === "guidance";
    if (entry.kind === "message" && entry.message.role === "user" && (!isGuidance || !current)) {
      finishCurrent();
      current = {
        id: entry.id,
        userEntryId: entry.id,
        summaryEntryId: null,
        entryIds: [entry.id],
        startedAt: entry.createdAt,
        completedAt: entry.createdAt,
        lastFormalAssistantEntryId: null
      };
      continue;
    }
    if (!current) continue;
    current.entryIds.push(entry.id);
    if (Date.parse(entry.createdAt) > Date.parse(current.completedAt)) {
      current.completedAt = entry.createdAt;
    }
    if (entry.kind === "message" && entry.message.role === "assistant") {
      if (getMessageDisplayKind(entry.message) !== "commentary") {
        current.lastFormalAssistantEntryId = entry.id;
      }
    }
  }
  finishCurrent();
  return sections;
}

export function getDefaultCollapsedConversationTurnIds(
  sections: Array<{ id: string }>,
  latestTurnId: string | null,
  isTaskProcessing: boolean
): string[] {
  return sections
    .filter((section) => !isTaskProcessing || section.id !== latestTurnId)
    .map((section) => section.id);
}

export function buildToolGroupTimelineEntries(toolCalls: ToolCallRecord[], messages: MessageRecord[]): TimelineEntry[] {
  const callsById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const assignedCallIds = new Set<string>();
  const groups = new Map<string, { createdAt: string; toolCalls: ToolCallRecord[] }>();

  const addToGroup = (groupId: string, createdAt: string, calls: ToolCallRecord[]) => {
    if (calls.length === 0) return;
    const group = groups.get(groupId) ?? { createdAt, toolCalls: [] };
    group.toolCalls.push(...calls);
    groups.set(groupId, group);
    for (const toolCall of calls) assignedCallIds.add(toolCall.id);
  };

  const visibleMessagesByTurn = new Map<string, MessageRecord[]>();
  for (const message of messages) {
    if (
      message.role === "tool" ||
      !message.turnRunId ||
      !message.content.trim() ||
      getMessageDisplayKind(message) === "tool_batch" ||
      isPatchAssistantMessage(message.content) ||
      (message.role === "assistant" && isInternalAgentProtocolMessage(message.content))
    ) continue;
    visibleMessagesByTurn.set(message.turnRunId, [
      ...(visibleMessagesByTurn.get(message.turnRunId) ?? []),
      message
    ]);
  }

  // Visible commentary explicitly identifies its first tool batch. Later
  // tool-only decisions remain in the same visible-message interval and are
  // merged into this group by the fallback pass below.
  for (const message of messages) {
    if (getMessageDisplayKind(message) === "tool_batch" || !message.content.trim()) continue;
    const toolCallIds = getCommentaryToolCallIds(message);
    const groupedToolCalls = toolCallIds
      .map((toolCallId) => callsById.get(toolCallId))
      .filter((toolCall): toolCall is ToolCallRecord => !!toolCall && !assignedCallIds.has(toolCall.id));
    addToGroup(`message-${message.id}`, message.createdAt, groupedToolCalls);
  }

  // Group every remaining call by the nearest preceding visible message. Hidden
  // tool-batch anchors are intentionally ignored: they are model protocol
  // details, not conversation boundaries.
  for (const toolCall of toolCalls) {
    if (assignedCallIds.has(toolCall.id)) continue;
    const callStartedAt = Date.parse(toolCall.startedAt);
    const precedingMessage = [...(visibleMessagesByTurn.get(toolCall.turnRunId) ?? [])]
      .filter((message) => Date.parse(message.createdAt) <= callStartedAt)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    const groupId = precedingMessage ? `message-${precedingMessage.id}` : toolCall.turnRunId || `legacy-${toolCall.id}`;
    const createdAt = precedingMessage?.createdAt ?? toolCall.startedAt;
    addToGroup(groupId, createdAt, [toolCall]);
  }

  return [...groups.entries()].map(([groupId, group]) =>
    createToolGroupTimelineEntry(groupId, group.toolCalls, group.createdAt)
  );
}

export function createToolGroupTimelineEntry(
  groupId: string,
  toolCalls: ToolCallRecord[],
  fallbackCreatedAt?: string
): TimelineEntry {
  const sortedToolCalls = [...toolCalls].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)
  );
  return {
    kind: "tool-group",
    id: `tool-group-${groupId}`,
    createdAt: fallbackCreatedAt ?? sortedToolCalls[0]?.startedAt ?? new Date().toISOString(),
    toolCalls: sortedToolCalls
  };
}

export function getCommentaryToolCallIds(message: MessageRecord): string[] {
  if (message.role !== "assistant" || !message.metadataJson) return [];
  try {
    const metadata = JSON.parse(message.metadataJson) as { displayKind?: unknown; toolCallIds?: unknown };
    return (metadata.displayKind === "commentary" || metadata.displayKind === "tool_batch") && Array.isArray(metadata.toolCallIds)
      ? metadata.toolCallIds.filter((toolCallId): toolCallId is string => typeof toolCallId === "string")
      : [];
  } catch {
    return [];
  }
}

export function getTurnSummaryCreatedAt(
  turnRunId: string,
  messages: MessageRecord[],
  toolCalls: ToolCallRecord[],
  artifacts: ArtifactRecord[] = []
): string {
  const timestamps = [
    ...messages
      .filter((message) => message.turnRunId === turnRunId && !isPatchAssistantMessage(message.content))
      .map((message) => Date.parse(message.createdAt)),
    ...toolCalls
      .filter((toolCall) => toolCall.turnRunId === turnRunId)
      .map((toolCall) => Date.parse(toolCall.completedAt ?? toolCall.startedAt)),
    // Knowledge-index / orphan artifacts have no turnRunId; keep them anchored to
    // artifact.createdAt so they don't float to the bottom on every rerender.
    ...artifacts
      .filter((artifact) => (artifact.turnRunId ?? `artifact-${artifact.id}`) === turnRunId)
      .map((artifact) => Date.parse(artifact.createdAt))
  ].filter(Number.isFinite);
  const latest = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
  return new Date(latest + 1).toISOString();
}

export function isFileWriteTool(toolName: string): boolean {
  return toolName === "apply_patch" || toolName === "fs.write_file";
}

export function isPatchAssistantMessage(content: string): boolean {
  return /^\s*(?:```(?:diff|patch)?\s*)?\*\*\* Begin Patch\b/m.test(content);
}

export function isInternalAgentProtocolMessage(content: string): boolean {
  if (/\b(?:tool_call_id|completed_task_ids|completion_evidence)\b/i.test(content)) {
    return true;
  }
  // Decision envelopes sometimes arrive malformed while streaming. Treat a
  // leading assistant_message object as protocol content even before the rest
  // of its keys have arrived, so it cannot be rendered as a sticky JSON block.
  return /^\s*(?:```json\s*)?\{[\s\S]{0,240}"assistant_message"\s*:/i.test(content);
}

export function collapseDirectoryReadMessages(entries: TimelineEntry[]): TimelineEntry[] {
  const collapsed: TimelineEntry[] = [];

  for (let index = 0; index < entries.length; ) {
    const entry = entries[index];
    if (entry.kind !== "message") {
      collapsed.push(entry);
      index += 1;
      continue;
    }
    const directory = getReadDirectory(entry.message);
    if (!directory) {
      collapsed.push(entry);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < entries.length) {
      const candidate = entries[end];
      if (
        candidate.kind !== "message" ||
        candidate.message.turnRunId !== entry.message.turnRunId ||
        getReadDirectory(candidate.message) !== directory
      ) {
        break;
      }
      end += 1;
    }

    const count = end - index;
    if (count === 1) {
      collapsed.push(entry);
    } else {
      collapsed.push({
        kind: "directory-read-group",
        id: `directory-read-${entry.message.id}`,
        createdAt: entry.createdAt,
        directory,
        count
      });
    }
    index = end;
  }

  return collapsed;
}

export function getReadDirectory(message: MessageRecord): string | null {
  if (message.role !== "assistant") {
    return null;
  }
  const match = message.content.match(/(?:检查|读取)\s*`?([^`\s]+)`?\s*目录(?:内容)?/);
  return match?.[1]?.trim() || null;
}

export function collectFileChangesByTurn(
  toolCalls: ToolCallRecord[],
  workspaceRoot?: string | null
): Map<string, FileChangeSummaryItem[]> {
  const changesByTurn = new Map<string, Map<string, FileChangeSummaryItem>>();

  for (const toolCall of toolCalls) {
    if (!toolCallSucceeded(toolCall)) {
      continue;
    }

    const files = getToolFileChanges(toolCall, workspaceRoot);
    if (files.length === 0) {
      continue;
    }

    const turnChanges = changesByTurn.get(toolCall.turnRunId) ?? new Map<string, FileChangeSummaryItem>();
    for (const file of files) {
      const existing = turnChanges.get(file.path);
      turnChanges.set(file.path, mergeFileChange(existing, file));
    }
    changesByTurn.set(toolCall.turnRunId, turnChanges);
  }

  return new Map(
    [...changesByTurn.entries()].map(([turnRunId, files]) => [turnRunId, [...files.values()]])
  );
}

export function toolCallSucceeded(toolCall: ToolCallRecord) {
  if (toolCall.status !== "completed") {
    return false;
  }

  return parseTimelineJson(toolCall.resultJson).ok !== false;
}

export function getToolFileChanges(
  toolCall: ToolCallRecord,
  workspaceRoot?: string | null
): FileChangeSummaryItem[] {
  const input = parseTimelineJson(toolCall.argumentsJson);

  const result = parseTimelineJson(toolCall.resultJson);
  const resultJson = result.json as Record<string, unknown> | undefined;

  if (toolCall.toolName === "apply_patch") {
    const structured = Array.isArray(resultJson?.changes) ? resultJson.changes : null;
    if (structured) {
      const touched = Array.isArray(resultJson?.touched) ? resultJson.touched : [];
      return structured.map((raw, index) => {
        const change = raw as Record<string, unknown>;
        const relativePath = toWorkspaceRelativePath(String(change.path ?? ""), workspaceRoot);
        const actionRaw = String(change.action ?? "update");
        const action: FileChangeAction =
          actionRaw === "add" ? "created" : actionRaw === "delete" ? "deleted" : "modified";
        const symbols = Array.isArray(change.symbols)
          ? (change.symbols as Array<Record<string, unknown>>)
              .map((symbol) => ({
                name: String(symbol.name ?? ""),
                kind: String(symbol.kind ?? "symbol"),
                change: String(symbol.change ?? "modified")
              }))
              .filter((symbol) => symbol.name)
          : undefined;
        return decorateGeneratedFileChange({
          path: relativePath,
          absolutePath: typeof touched[index] === "string" ? touched[index] : undefined,
          action,
          additions: Number(change.additions ?? 0),
          deletions: Number(change.deletions ?? 0),
          symbols,
          snapshot: findResultFileSnapshot(resultJson, relativePath, workspaceRoot)
        });
      });
    }

    const changes = parsePatchFileChanges(String(input.patch ?? ""), workspaceRoot);
    const touched = Array.isArray(resultJson?.touched)
      ? resultJson.touched
      : Array.isArray(result.touched) ? result.touched : [];
    return changes.map((change, index) => decorateGeneratedFileChange({
      ...change,
      absolutePath: typeof touched[index] === "string" ? touched[index] : undefined,
      snapshot: findResultFileSnapshot(resultJson, change.path, workspaceRoot)
    }));
  }

  if (toolCall.toolName === "code.ast_diff") {
    const path = typeof resultJson?.path === "string"
      ? resultJson.path
      : typeof input.path === "string" ? input.path : "";
    const entities = Array.isArray(resultJson?.entities) ? resultJson.entities : [];
    const symbols = entities
      .map((raw) => {
        const entity = raw as Record<string, unknown>;
        return {
          name: String(entity.name ?? ""),
          kind: String(entity.kind ?? "symbol"),
          change: String(entity.change ?? "modified")
        };
      })
      .filter((symbol) => symbol.name);
    return path
      ? [{
          path: toWorkspaceRelativePath(path, workspaceRoot),
          action: "modified" as const,
          additions: symbols.filter((symbol) => symbol.change === "added").length,
          deletions: symbols.filter((symbol) => symbol.change === "removed").length,
          symbols,
          snapshot: findResultFileSnapshot(resultJson, path, workspaceRoot)
        }]
      : [];
  }

  if (toolCall.toolName === "fs.write_file") {
    const path = typeof input.path === "string" ? input.path : "";
    const absolutePath = typeof resultJson?.path === "string"
      ? resultJson.path
      : typeof result.path === "string" ? result.path : undefined;
    return path
      ? [decorateGeneratedFileChange({
          path: toWorkspaceRelativePath(path, workspaceRoot),
        absolutePath,
        action: "created",
        additions: 0,
        deletions: 0,
        snapshot: findResultFileSnapshot(resultJson, path, workspaceRoot)
      })]
      : [];
  }

  return [];
}

export function findResultFileSnapshot(
  resultJson: Record<string, unknown> | undefined,
  filePath: string,
  workspaceRoot?: string | null
): FileSnapshot | undefined {
  const snapshots = resultJson?.snapshots;
  if (!Array.isArray(snapshots)) return undefined;
  const targetPath = toWorkspaceRelativePath(filePath, workspaceRoot).replace(/\\/g, "/").toLowerCase();
  for (const candidate of snapshots) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as Record<string, unknown>;
    if (typeof value.path !== "string" || typeof value.before !== "string" || typeof value.after !== "string") continue;
    const snapshotPath = toWorkspaceRelativePath(value.path, workspaceRoot).replace(/\\/g, "/");
    if (snapshotPath.toLowerCase() !== targetPath) continue;
    return {
      path: snapshotPath,
      before: value.before,
      after: value.after,
      beforeTruncated: value.beforeTruncated === true,
      afterTruncated: value.afterTruncated === true
    };
  }
  return undefined;
}

export function parsePatchFileChanges(patch: string, workspaceRoot?: string | null): FileChangeSummaryItem[] {
  const files: FileChangeSummaryItem[] = [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let current: FileChangeSummaryItem | null = null;

  for (const line of lines) {
    const fileMatch = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (fileMatch) {
      current = {
        path: toWorkspaceRelativePath(fileMatch[2], workspaceRoot),
        action: fileMatch[1] === "Add" ? "created" : fileMatch[1] === "Delete" ? "deleted" : "modified",
        additions: 0,
        deletions: 0
      };
      files.push(current);
      continue;
    }

    if (!current || line.startsWith("*** ") || line.startsWith("@@")) {
      continue;
    }

    if (line.startsWith("+")) {
      current.additions += 1;
    } else if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }

  return files.map((file) => decorateGeneratedFileChange(file));
}

export function mergeFileChange(existing: FileChangeSummaryItem | undefined, next: FileChangeSummaryItem): FileChangeSummaryItem {
  if (!existing) {
    return next;
  }

  const symbolMap = new Map<string, { name: string; kind: string; change: string }>();
  for (const symbol of [...(existing.symbols ?? []), ...(next.symbols ?? [])]) {
    symbolMap.set(`${symbol.change}:${symbol.kind}:${symbol.name}`, symbol);
  }

  return {
    path: next.path,
    absolutePath: next.absolutePath ?? existing.absolutePath,
    action: existing.action === "created" && next.action === "modified" ? "created" : next.action,
    additions: existing.additions + next.additions,
    deletions: existing.deletions + next.deletions,
    kind: next.kind ?? existing.kind,
    description: next.description ?? existing.description,
    symbols: symbolMap.size > 0 ? [...symbolMap.values()] : undefined,
    snapshot: existing.snapshot && next.snapshot
      ? {
          path: next.snapshot.path,
          before: existing.snapshot.before,
          after: next.snapshot.after,
          beforeTruncated: existing.snapshot.beforeTruncated,
          afterTruncated: next.snapshot.afterTruncated
        }
      : next.snapshot ?? existing.snapshot
  };
}

export function toWorkspaceRelativePath(filePath: string, workspaceRoot?: string | null) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedRoot = workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "");

  if (normalizedRoot && normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return normalizedPath;
}

export function decorateGeneratedFileChange(file: FileChangeSummaryItem): FileChangeSummaryItem {
  if (file.kind === "generated-image" || file.kind === "generated-video" || file.kind === "generated-file") {
    return {
      ...file,
      description: file.description ?? getGeneratedFileDescription(file.path, file.kind)
    };
  }
  if (file.action !== "created") {
    return file;
  }
  return {
    ...file,
    kind: "generated-file",
    description: file.description ?? getGeneratedFileDescription(file.path, "generated-file", undefined, file.action)
  };
}

export function getGeneratedFileDescription(
  path: string,
  kind?: FileChangeSummaryItem["kind"],
  artifactKind?: string,
  action?: FileChangeAction
): string {
  if (artifactKind === "browser-screenshot") return "浏览器截图";
  if (artifactKind === "browser-snapshot") return "浏览器快照";
  if (artifactKind === "knowledge-index") return "知识库索引";
  if (kind === "generated-video") return "生成的视频";
  if (kind === "generated-image") return "生成的图片";

  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "markdown", "txt", "docx", "pdf"].includes(extension)) return "生成的文档";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"].includes(extension)) return "生成的图片";
  if (["mp4", "webm", "mov"].includes(extension)) return "生成的视频";
  if (["json", "csv", "yaml", "yml", "toml", "xlsx", "xls"].includes(extension)) return "生成的数据文件";
  if (action === "created" || kind === "generated-file") return "生成的文件";
  return "生成的文件";
}

export type PlanTimelineItem = {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "completed";
};

export function buildPlanTimelineItems(state: GpaState): PlanTimelineItem[] {
  const phases: Array<{ id: Exclude<GpaStage, "off">; label: string }> = [
    { id: "goal", label: "Inspect and clarify the goal" },
    { id: "plan", label: "Build an executable plan" },
    { id: "act", label: "Implement and verify changes" }
  ];
  const order: Record<Exclude<GpaStage, "off">, number> = { goal: 0, plan: 1, act: 2 };
  const current = order[state.stage as Exclude<GpaStage, "off">] ?? 0;
  const currentTaskIndex = state.planTasks.findIndex((task) => !task.done);
  return state.planTasks.length
    ? state.planTasks.map((task, index) => ({
        id: task.id,
        label: task.title,
        status: task.done ? "completed" as const : index === currentTaskIndex ? "in_progress" as const : "pending" as const
      }))
    : phases.map((phase, index) => ({
        id: phase.id,
        label: phase.label,
        status: index < current ? "completed" : index === current ? "in_progress" : "pending" as const
    }));
}

export function getActivePlanTimelineItem(items: PlanTimelineItem[]): PlanTimelineItem | null {
  return items.find((item) => item.status === "in_progress") ?? null;
}

export function getGpaPlanMessageId(messages: MessageRecord[], state: GpaState): string | null {
  if ((state.stage !== "plan" && state.stage !== "act") || state.planTasks.length === 0) {
    return null;
  }
  const taskHeadingPatterns = state.planTasks.map((task) => new RegExp(
    `(?:^|\\n)\\s*###\\s*${escapeRegExp(task.id)}\\s*:`,
    "i"
  ));
  return [...messages].reverse().find(
    (message) => message.role === "assistant" && taskHeadingPatterns.every((pattern) => pattern.test(message.content))
  )?.id ?? null;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getToolProcessingLabel(toolName: string, argumentsJson = "{}"): string {
  const input = parseTimelineJson(argumentsJson);
  const rawTarget = input.command ?? input.path ?? input.filePath ?? input.query ?? input.pattern ?? input.url;
  const target = typeof rawTarget === "string" ? compactRuntimeTarget(rawTarget) : "";
  if (toolName === "apply_patch") {
    const file = parsePatchFileChanges(String(input.patch ?? ""))[0]?.path;
    return file ? `正在修改 ${compactRuntimeTarget(file)}` : "正在写入文件";
  }
  if (toolName === "fs.read_file" || toolName === "knowledge.read" || toolName === "read_mcp_resource") {
    return target ? `正在读取 ${target}` : "正在读取文件";
  }
  if (toolName === "fs.read_directory" || toolName === "list_mcp_resources" || toolName === "list_mcp_resource_templates") {
    return target ? `正在查看 ${target}` : "正在读取目录";
  }
  if (toolName === "fs.write_file" || toolName === "apply_patch") {
    return target ? `正在写入 ${target}` : "正在写入文件";
  }
  if (toolName === "code.search" || toolName === "knowledge.search") {
    return target ? `正在搜索 ${target}` : "正在搜索代码";
  }
  if (toolName === "web_search.search_query") {
    return target ? `正在搜索 ${target}` : "正在搜索网络";
  }
  if (toolName === "browser.set_viewport") {
    const width = Number(input.width ?? 1440);
    const height = Number(input.height ?? 900);
    return `正在验证页面 · ${width <= 500 ? "手机" : "桌面"} ${width}×${height}`;
  }
  if (toolName === "browser.assert_page") return "正在执行页面断言";
  if (toolName === "browser.capture_screenshot") return "正在截取页面验证图";
  if (toolName.startsWith("browser.") || toolName === "web_search.open_page") {
    return target ? `正在打开 ${target}` : "正在操作浏览器";
  }
  if (toolName.startsWith("git.")) {
    return toolName === "git.commit" ? "正在创建提交" : "正在检查 Git 状态";
  }
  if (toolName === "shell.exec") {
    return target ? `正在运行 ${target}` : "正在执行命令";
  }
  if (toolName === "multi_agents.spawn") {
    return "正在启动子任务";
  }
  if (toolName === "spawn_agent") return "正在启动子智能体";
  if (isSubagentWaitTool(toolName)) return "正在等待子智能体";
  return "正在调用工具";
}

export function compactRuntimeTarget(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 88 ? `${singleLine.slice(0, 85)}...` : singleLine;
}

export function getActiveSubagents<T extends Pick<ThreadRecord, "id" | "status">>(
  agents: T[],
  queuedAgentIds: Set<string>
): T[] {
  return agents.filter(
    (agent) => queuedAgentIds.has(agent.id) || agent.status === "running" || agent.status === "waiting"
  );
}

export function isSubagentWaitTool(toolName: string | null | undefined): boolean {
  return toolName === "wait_agent" || toolName === "multi_agents.wait";
}

export function getSubagentWaitLabel(
  agents: Array<Pick<ThreadRecord, "id" | "status">>,
  queuedAgentIds: Set<string>
): string | null {
  const queuedCount = agents.filter((agent) => queuedAgentIds.has(agent.id)).length;
  const runningCount = agents.filter(
    (agent) => !queuedAgentIds.has(agent.id) && agent.status === "running"
  ).length;
  const attentionCount = agents.filter(
    (agent) => !queuedAgentIds.has(agent.id) && agent.status === "waiting"
  ).length;
  const waitingCount = queuedCount + runningCount + attentionCount;
  if (waitingCount === 0) return null;
  const breakdown = [
    runningCount > 0 ? `${runningCount} 运行` : null,
    attentionCount > 0 ? `${attentionCount} 等待处理` : null,
    queuedCount > 0 ? `${queuedCount} 排队` : null
  ].filter(Boolean);
  return `正在等待 ${waitingCount} 个子智能体${breakdown.length ? ` · ${breakdown.join(" · ")}` : ""}`;
}

export function getToolActivitySummary(toolCalls: ToolCallRecord[], runningCall?: ToolCallRecord) {
  if (runningCall) {
    return {
      title: getToolProcessingLabel(runningCall.toolName, runningCall.argumentsJson),
      detail: ""
    };
  }

  const counts = { search: 0, read: 0, write: 0, verify: 0, browser: 0, other: 0 };
  const failedCalls = toolCalls.filter((toolCall) => toolCall.status === "failed" || toolCall.status === "denied");
  const writtenPaths = new Set<string>();
  for (const toolCall of toolCalls) {
    const kind = getToolActivityKind(toolCall);
    counts[kind] += 1;
    if (kind === "write" && toolCall.status === "completed") {
      for (const target of getToolWriteTargets(toolCall)) writtenPaths.add(target);
    }
  }

  const subject = getToolActivitySubject(counts);
  const completedDetail = [
    counts.search ? `\u67e5\u8be2 ${counts.search} \u6b21` : "",
    counts.read ? `\u8bfb\u53d6 ${counts.read} \u9879` : "",
    counts.write ? `\u5199\u5165 ${counts.write} \u6b21\uff08\u6d89\u53ca ${writtenPaths.size} \u4e2a\u6587\u4ef6\uff09` : "",
    counts.verify ? `\u9a8c\u8bc1 ${counts.verify} \u6b21` : "",
    counts.browser ? `\u9875\u9762\u64cd\u4f5c ${counts.browser} \u6b21` : "",
    counts.other ? `\u5176\u4ed6\u5904\u7406 ${counts.other} \u6b21` : ""
  ].filter(Boolean).join(" \u00b7 ");

  if (failedCalls.length > 0) {
    return {
      title: `\u90e8\u5206${subject}\u672a\u5b8c\u6210`,
      detail: `\u5df2\u5c1d\u8bd5 ${toolCalls.length} \u6b21${subject} \u00b7 ${failedCalls.length} \u6b21\u5931\u8d25`
    };
  }

  return {
    title: `\u5df2\u5b8c\u6210${subject}`,
    detail: completedDetail || `\u5df2\u5904\u7406 ${toolCalls.length} \u6b65`
  };
}

export function getToolWriteTargets(toolCall: ToolCallRecord): string[] {
  const input = parseTimelineJson(toolCall.argumentsJson);
  if (toolCall.toolName === "fs.write_file") {
    const path = input.path ?? input.filePath;
    return typeof path === "string" && path.trim() ? [path.trim()] : [];
  }

  const patch = typeof input.patch === "string" ? input.patch : "";
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((path): path is string => !!path);
}

export function getToolActivityPresentation(toolCalls: ToolCallRecord[]) {
  const runningCall = toolCalls.find((toolCall) => toolCall.status === "running" || toolCall.status === "pending");
  const failed = toolCalls.some((toolCall) => toolCall.status === "failed" || toolCall.status === "denied");
  const blocked = toolCalls.some((toolCall) => toolCall.status === "blocked");

  return {
    runningCall,
    status: runningCall ? "in_progress" : failed ? "failed" : blocked ? "blocked" : "completed",
    summary: getToolActivitySummary(toolCalls, runningCall)
  };
}

export function getToolActivitySubject(counts: { search: number; read: number; write: number; verify: number; browser: number; other: number }): string {
  const labels = [
    counts.search ? "\u67e5\u8be2" : "",
    counts.read ? "\u8bfb\u53d6" : "",
    counts.write ? "\u4fee\u6539" : "",
    counts.verify ? "\u9a8c\u8bc1" : "",
    counts.browser ? "\u9875\u9762\u64cd\u4f5c" : ""
  ].filter(Boolean);
  return labels.slice(0, 2).join("\u4e0e") || "\u5904\u7406";
}

export function getToolActivityKind(toolCall: ToolCallRecord): "search" | "read" | "write" | "verify" | "browser" | "other" {
  const { toolName } = toolCall;
  if (isFileWriteTool(toolName)) return "write";
  if (
    toolName === "code.search" ||
    toolName === "knowledge.search" ||
    toolName === "web_search.search_query" ||
    toolName === "mcp.call" ||
    toolName === "mcp.list_tools" ||
    toolName === "list_mcp_resources" ||
    toolName === "list_mcp_resource_templates"
  ) return "search";
  if (toolName === "fs.read_file" || toolName === "fs.read_directory" || toolName === "knowledge.read" || toolName === "read_mcp_resource") return "read";
  if (toolName === "browser.assert_page" || toolName === "browser.capture_screenshot" || isVerificationCommand(toolCall)) return "verify";
  if (toolName.startsWith("browser.") || toolName === "web_search.open_page") return "browser";
  return "other";
}

export function isVerificationCommand(toolCall: ToolCallRecord): boolean {
  if (toolCall.toolName !== "shell.exec" && toolCall.toolName !== "execute_command") return false;
  const command = String(parseTimelineJson(toolCall.argumentsJson).command ?? "");
  return /\b(test|build|lint|typecheck|vitest|jest|playwright|pytest)\b/i.test(command);
}

export function getFileWriteTarget(input: Record<string, unknown>) {
  const path = input.path ?? input.filePath;
  if (typeof path === "string" && path.trim()) return path;
  const patch = input.patch;
  if (typeof patch === "string") {
    const match = patch.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
    if (match?.[1]) return match[1];
  }
  return "文件变更";
}

export function parseTimelineJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function mergeSnapshotRecords<T extends { id: string }>(
  previous: T[],
  changes: T[],
  getCreatedAt: (item: T) => string,
  direction: "ascending" | "descending" = "ascending"
): T[] {
  if (changes.length === 0) {
    return previous;
  }

  const changedById = new Map(changes.map((item) => [item.id, item]));
  const merged = previous.map((item) => changedById.get(item.id) ?? item);
  const existingIds = new Set(previous.map((item) => item.id));
  for (const item of changes) {
    if (!existingIds.has(item.id)) {
      merged.push(item);
    }
  }

  const multiplier = direction === "ascending" ? 1 : -1;
  return merged.sort((left, right) => multiplier * getCreatedAt(left).localeCompare(getCreatedAt(right)));
}

export function resolveLatestThreadRecord(current: ThreadRecord, incoming: ThreadRecord): ThreadRecord {
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const incomingUpdatedAt = Date.parse(incoming.updatedAt);
  if (
    Number.isFinite(currentUpdatedAt) &&
    Number.isFinite(incomingUpdatedAt) &&
    currentUpdatedAt > incomingUpdatedAt
  ) {
    return current;
  }
  return incoming;
}

export function parseMessageEventBlocks(message: MessageRecord): ChatEventBlock[] | null {
  if (message.role === "tool") {
    return buildToolEventBlocks(message);
  }

  if (message.role === "assistant" || message.role === "system") {
    return parseStructuredEventBlocks(message.content);
  }

  return null;
}

export function parseStructuredEventBlocks(content: string): ChatEventBlock[] | null {
  const xmlBlocks = parseXmlEventBlocks(content);
  if (xmlBlocks && xmlBlocks.length > 0) {
    return xmlBlocks;
  }

  return parseLabeledEventBlocks(content);
}

export function parseXmlEventBlocks(content: string): ChatEventBlock[] | null {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const eventPattern = /<event\b([^>]*)>([\s\S]*?)<\/event>/gi;
  const blocks: ChatEventBlock[] = [];
  let matched = false;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = eventPattern.exec(normalized)) !== null) {
    matched = true;
    const before = normalized.slice(lastIndex, match.index).trim();
    if (before) {
      blocks.push({ type: "commentary", content: before });
    }

    const attributes = parseEventAttributes(match[1] ?? "");
    const type = normalizeEventType(attributes.type);
    if (type) {
      blocks.push({
        type,
        content: match[2].trim(),
        title: attributes.title,
        name: attributes.name,
        status: attributes.status,
        path: attributes.path,
        action: attributes.action,
        startLine: parseNumericAttribute(attributes.start_line),
        durationMs: parseNumericAttribute(attributes.duration_ms),
        exitCode: parseNumericAttribute(attributes.exit_code),
        ok: parseBooleanAttribute(attributes.ok)
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (!matched) {
    return null;
  }

  const after = normalized.slice(lastIndex).trim();
  if (after) {
    blocks.push({ type: "commentary", content: after });
  }

  return blocks;
}

export function parseLabeledEventBlocks(content: string): ChatEventBlock[] | null {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const blocks: ChatEventBlock[] = [];
  let current: { type: ChatEventType; lines: string[]; explicit: boolean } | null = null;
  let sawExplicitEvent = false;
  let inCodeFence = false;

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    const nextContent = current.lines.join("\n").trim();
    if (nextContent || current.explicit) {
      blocks.push({
        type: current.type,
        content: nextContent
      });
    }
    current = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      if (!current) {
        current = { type: "commentary", lines: [rawLine], explicit: false };
      } else {
        current.lines.push(rawLine);
      }
      continue;
    }

    const match =
      !inCodeFence &&
      trimmed.match(/^(commentary|tool_call|tool_result|file_view|file_change|test_result|final)(?:\s*[:|-]\s*(.*))?$/i);

    if (match) {
      sawExplicitEvent = true;
      pushCurrent();
      current = {
        type: match[1].toLowerCase() as ChatEventType,
        lines: match[2]?.trim() ? [match[2].trim()] : [],
        explicit: true
      };
      continue;
    }

    if (!current) {
      current = { type: "commentary", lines: [rawLine], explicit: false };
      continue;
    }

    current.lines.push(rawLine);
  }

  pushCurrent();

  return sawExplicitEvent ? blocks : null;
}

export function buildToolEventBlocks(message: MessageRecord): ChatEventBlock[] {
  const normalized = message.content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const title = lines[0]?.trim() || "tool";
  const resultContent = lines.slice(1).join("\n").trim();

  return [
    {
      type: "tool_call",
      title,
      name: title,
      status: "completed",
      content: ""
    },
    {
      type: "tool_result",
      name: title,
      status: "completed",
      content: resultContent || "Tool completed."
    }
  ];
}

export function parseEventAttributes(source: string) {
  const attributes: Record<string, string> = {};
  const attributePattern = /([a-zA-Z0-9_:-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(source)) !== null) {
    attributes[match[1].toLowerCase()] = match[2];
  }

  return attributes;
}

export function normalizeEventType(value?: string): ChatEventType | null {
  switch ((value ?? "").trim().toLowerCase().replace(/-/g, "_")) {
    case "commentary":
      return "commentary";
    case "tool_call":
      return "tool_call";
    case "tool_result":
      return "tool_result";
    case "file_view":
      return "file_view";
    case "file_change":
      return "file_change";
    case "test_result":
      return "test_result";
    case "final":
      return "final";
    default:
      return null;
  }
}

export function parseBooleanAttribute(value?: string) {
  if (!value) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

export function parseNumericAttribute(value?: string) {
  if (!value) {
    return undefined;
  }

  const next = Number(value);
  return Number.isFinite(next) ? next : undefined;
}

export function filterTranscriptMessages(messages: MessageRecord[], threadStatus?: ThreadRecord["status"] | null) {
  if (messages.length === 0) {
    return messages;
  }

  const activeTurnRunId = isThreadExecutionInProgress(threadStatus ?? null)
    ? [...messages].reverse().find((message) => message.turnRunId)?.turnRunId ?? null
    : null;
  const turnIdsWithOutcome = new Set<string>();
  let hasStandaloneOutcome = false;

  for (const message of messages) {
    if (!isOutcomeTranscriptMessage(message)) {
      continue;
    }

    if (message.turnRunId) {
      turnIdsWithOutcome.add(message.turnRunId);
    } else {
      hasStandaloneOutcome = true;
    }
  }

  const hasAnyOutcome = hasStandaloneOutcome || turnIdsWithOutcome.size > 0;

  const filteredMessages = messages.filter((message) => {
    if (message.content.trimStart().startsWith("[internal:")) {
      return false;
    }

    if (message.role === "assistant" && /\[Executed tools:\s*[^\]\r\n]+\]/i.test(message.content)) {
      return false;
    }

    if (!isCommentaryOnlyTranscriptMessage(message)) {
      return true;
    }

    if (message.turnRunId) {
      if (activeTurnRunId && message.turnRunId === activeTurnRunId) {
        return true;
      }

      return !turnIdsWithOutcome.has(message.turnRunId);
    }

    return !hasAnyOutcome;
  });

  const visibleAssistantMessages = new Set<string>();
  return filteredMessages.filter((message) => {
    if (message.role !== "assistant" || !message.turnRunId) {
      return true;
    }

    const fingerprint = message.content.replace(/\s+/g, " ").trim();
    const displayKind = getMessageDisplayKind(message);
    const messageKey = displayKind === "commentary"
      ? `${message.turnRunId}:commentary:${fingerprint}`
      : `${message.turnRunId}:message:${fingerprint}`;
    if (!fingerprint || visibleAssistantMessages.has(messageKey)) {
      return !fingerprint;
    }

    visibleAssistantMessages.add(messageKey);
    return true;
  });
}

export function getMessageDisplayKind(message: MessageRecord): string | null {
  if (!message.metadataJson) return null;
  try {
    const displayKind = JSON.parse(message.metadataJson).displayKind;
    return typeof displayKind === "string" ? displayKind : null;
  } catch {
    return null;
  }
}

export function isCommentaryOnlyTranscriptMessage(message: MessageRecord) {
  if (message.role !== "assistant" && message.role !== "system") {
    return false;
  }

  const eventBlocks = parseMessageEventBlocks(message);
  return Boolean(eventBlocks && eventBlocks.length > 0 && eventBlocks.every((block) => block.type === "commentary"));
}

export function isOutcomeTranscriptMessage(message: MessageRecord) {
  if (message.role === "tool") {
    return true;
  }

  if (message.role !== "assistant" && message.role !== "system") {
    return false;
  }

  const eventBlocks = parseMessageEventBlocks(message);
  if (!eventBlocks || eventBlocks.length === 0) {
    return Boolean(message.content.trim());
  }

  return eventBlocks.some((block) => block.type !== "commentary");
}

export function getThreadDeleteFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/\bEBUSY\b|resource busy|resource.*locked|\brmdir\b/i.test(message)) {
    return "该任务的终端或预览仍在使用临时文件。请关闭该任务的终端或预览后重试；若仍失败，请完全退出并重新打开 CodeXH 后再删除。";
  }
  return message || "请稍后重试。";
}

export function reconcilePendingUserMessages(
  pending: MessageRecord[],
  persisted: MessageRecord[]
): MessageRecord[] {
  const consumedPersistedIds = new Set<string>();

  return pending.filter((optimistic) => {
    const optimisticContent = normalizeUserMessageForReconciliation(optimistic.content);
    const optimisticCreatedAt = Date.parse(optimistic.createdAt);
    const matched = persisted.find((message) => {
      if (message.role !== "user" || consumedPersistedIds.has(message.id)) return false;
      const messageCreatedAt = Date.parse(message.createdAt);
      if (Number.isFinite(optimisticCreatedAt) && messageCreatedAt < optimisticCreatedAt - 1_000) return false;
      return normalizeUserMessageForReconciliation(message.content) === optimisticContent
        || normalizeUserMessageForReconciliation(getDisplayMessageContent(message)) === optimisticContent;
    });

    if (!matched) return true;
    consumedPersistedIds.add(matched.id);
    return false;
  });
}

export function replaceConversationMessagesFromEdit(
  messages: MessageRecord[],
  messageId: string,
  replacement: MessageRecord
): MessageRecord[] {
  const messageIndex = messages.findIndex((message) => message.id === messageId);
  if (messageIndex < 0) return [...messages, replacement];
  return [...messages.slice(0, messageIndex), replacement];
}

export function createOptimisticThreadSnapshot(thread: ThreadRecord): RuntimeThreadSnapshot {
  return {
    snapshotMode: "full",
    thread,
    messages: [],
    messageCount: 0,
    queuedMessages: [],
    approvals: [],
    prompts: [],
    artifacts: [],
    knowledgeBases: [],
    browserTabs: [],
    projectPlugins: [],
    toolCalls: [],
    contextCompaction: null,
    gpa: null,
    subagents: [],
    queuedSubagentIds: []
  };
}

export function isAssistantDraftPhase(value: unknown): value is AssistantDraftPhase {
  return value === "generating" || value === "validating" || value === "auditing" || value === "retrying";
}

export function getAssistantDraftPhaseLabel(phase: AssistantDraftPhase): string {
  switch (phase) {
    case "validating": return "正在检查回复";
    case "auditing": return "正在确认回复完整性";
    case "retrying": return "正在补充回复";
    default: return "正在起草回复";
  }
}

export function reconcileAssistantDraftUpdate(
  current: Record<string, AssistantDraft>,
  draft: AssistantDraft
): Record<string, AssistantDraft> {
  const existing = current[draft.draftId];
  if (existing?.completed) return current;
  const latestForThread = Object.values(current)
    .filter((entry) => entry.threadId === draft.threadId)
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (latestForThread && latestForThread.draftId !== draft.draftId && latestForThread.sequence > draft.sequence) {
    return current;
  }
  const next = Object.fromEntries(
    Object.entries(current).filter(([, entry]) => entry.threadId !== draft.threadId || entry.draftId === draft.draftId)
  );
  next[draft.draftId] = { ...existing, ...draft, completed: false };
  return next;
}

export function shouldKeepAssistantDraft(
  entry: { completed: boolean; messageId?: string },
  persistedMessages: MessageRecord[],
  threadStatus: ThreadRecord["status"] | null | undefined
): boolean {
  const persisted = entry.messageId
    ? persistedMessages.some((message) => message.id === entry.messageId)
    : false;
  if (entry.completed) return !persisted && Boolean(entry.messageId);
  return isThreadExecutionInProgress(threadStatus);
}

export function reconcileAssistantDraftCompletion(
  current: Record<string, AssistantDraft>,
  input: {
    turnRunId: string;
    draftId?: string;
    messageId?: unknown;
    discarded: boolean;
    suppressed: boolean;
  }
): Record<string, AssistantDraft> {
  const draftId = input.draftId ?? Object.values(current)
    .filter((entry) => entry.turnRunId === input.turnRunId)
    .sort((left, right) => right.sequence - left.sequence)[0]?.draftId;
  if (!draftId) return current;
  if (input.discarded || input.suppressed) {
    if (!current[draftId]) return current;
    const next = { ...current };
    delete next[draftId];
    return next;
  }
  const active = current[draftId];
  if (!active) return current;
  return {
    ...current,
    [draftId]: {
      ...active,
      completed: true,
      messageId: typeof input.messageId === "string" ? input.messageId : undefined
    }
  };
}

export function selectActiveAssistantDraft(
  entries: AssistantDraft[],
  threadId: string | null,
  threadStatus: ThreadRecord["status"] | null | undefined,
  persistedMessages: MessageRecord[]
): AssistantDraft | null {
  if (!threadId) return null;
  return entries
    .filter((entry) =>
      entry.threadId === threadId &&
      shouldKeepAssistantDraft(entry, persistedMessages, threadStatus)
    )
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1) ?? null;
}

export function getAssistantDraftDisplayContent(entry: Pick<AssistantDraft, "content">): string {
  if (isPatchAssistantMessage(entry.content) || isInternalAgentProtocolMessage(entry.content)) return "";
  return stripAssistantToolMarkup(entry.content);
}

export function getToolActivityTarget(
  toolName: string,
  input: Record<string, unknown>,
  command: string
): string {
  if (isFileWriteTool(toolName)) return getFileWriteTarget(input);
  return command === toolName ? "" : command;
}

export function normalizeUserMessageForReconciliation(content: string): string {
  return content.replace(/\r\n?/g, "\n").trim();
}

export function getDisplayMessageContent(message: MessageRecord): string {
  if (message.role === "user" && message.metadataJson) {
    try {
      const metadata = JSON.parse(message.metadataJson) as { displayContent?: unknown };
      if (typeof metadata.displayContent === "string") return metadata.displayContent;
    } catch {
      // Fall back to stored content for legacy messages with malformed metadata.
    }
  }
  if (message.role === "user" && message.content.trimStart().startsWith("[internal:")) {
    if (message.content.includes("gpa-resume")) {
      return "继续执行剩余的 GPA 计划任务";
    }
    if (message.content.includes("gpa-confirm") && message.content.includes("goal")) {
      return "已确认目标，开始制定计划";
    }
    if (message.content.includes("gpa-confirm")) {
      return "已确认计划，开始执行";
    }
    return "继续";
  }

  if (message.role === "user") {
    return stripSelectedComposerContexts(message.content);
  }

  if (message.role !== "assistant") {
    return message.content;
  }

  return stripAssistantToolMarkup(message.content);
}

export type SelectedMessageContext = {
  kind: "skill" | "mcp" | "database" | "code" | "folder" | "file";
  label: string;
};

export function getSelectedMessageContexts(content: string): SelectedMessageContext[] {
  const contexts: SelectedMessageContext[] = [];
  const add = (kind: SelectedMessageContext["kind"], label: string) => {
    const normalizedLabel = label.trim();
    if (!normalizedLabel || contexts.some((context) => context.kind === kind && context.label === normalizedLabel)) return;
    contexts.push({ kind, label: normalizedLabel });
  };

  for (const match of content.matchAll(/\[Selected Skill\]\s*\r?\n\s*([^\r\n:]+):[^\r\n]*(?=\r?\n{2,}|$)/gi)) add("skill", match[1] ?? "");
  for (const match of content.matchAll(/\[Selected MCP server\]\s*\r?\n\s*id:[^\r\n]*\r?\n\s*([^\r\n:]+):[^\r\n]*\r?\n[\s\S]*?(?=\r?\n{2,}|$)/gi)) add("mcp", match[1] ?? "");
  for (const match of content.matchAll(/\[Selected database\]\s*\r?\n\s*id:[^\r\n]*\r?\n\s*([^\r\n:]+):[^\r\n]*\r?\n[\s\S]*?(?=\r?\n{2,}|$)/gi)) add("database", match[1] ?? "");
  for (const match of content.matchAll(/(?:Edit|Reference) the following selected code from ([^\r\n:]+):\r?\n```[\s\S]*?```/gi)) add("code", match[1] ?? "");
  for (const match of content.matchAll(/\[Attached folder - required task context\]\s*\r?\npath:\s*([^\r\n]+)/gi)) add("folder", match[1] ?? "");
  for (const match of content.matchAll(/\[Attached file\]\s*\r?\n([^\r\n]+)/gi)) add("file", match[1] ?? "");
  return contexts;
}

export function stripSelectedComposerContexts(content: string): string {
  return content
    .replace(
      /\n{0,2}\[Selected Skill\]\s*\r?\n\s*[^\r\n:]+:[^\r\n]*(?=\r?\n{2,}|$)/gi,
      ""
    )
    .replace(
      /\n{0,2}\[Selected MCP server\]\s*\r?\n\s*id:[^\r\n]*\r?\n\s*[^\r\n:]+:[^\r\n]*\r?\nThis request requires querying this MCP server before answering\./gi,
      ""
    )
    .replace(
      /\n{0,2}\[Selected database\]\s*\r?\n\s*id:[^\r\n]*\r?\n[^\r\n]*\r?\nUse only this selected database source for this request when database access is needed\./gi,
      ""
    )
    .replace(
      /\n{0,2}(?:Edit|Reference) the following selected code from [^\r\n:]+:\r?\n```[\s\S]*?```/gi,
      ""
    )
    .replace(
      /\n{0,2}\[Attached folder - required task context\][\s\S]*?Do not claim the folder was inspected until those tool calls succeed\./gi,
      ""
    )
    .replace(
      /\n{0,2}\[Attached file\]\s*\r?\n[^\r\n]*/gi,
      ""
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripAssistantToolMarkup(content: string): string {
  const visible = content
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls\s*>/gi, "")
    .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result\s*>/gi, "")
    .replace(/<tool_calls\b[^>]*>[\s\S]*$/i, "")
    .replace(/<tool_result\b[^>]*>[\s\S]*$/i, "")
    .replace(/<\/tool_(?:calls|result)\s*>/gi, "")
    .replace(/\n{3,}/g, "\n\n");
  const tagStart = visible.lastIndexOf("<");
  if (tagStart === -1) {
    return visible;
  }

  const trailing = visible.slice(tagStart).toLowerCase();
  return "<tool_calls".startsWith(trailing) || "<tool_result".startsWith(trailing)
    ? visible.slice(0, tagStart)
    : visible;
}
