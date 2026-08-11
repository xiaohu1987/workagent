import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ApprovalRequest, AssistantDraftPhase, MessageAttachment, MessageRecord, ToolCallRecord, UserInputPrompt } from "@shared-types";
import { getDisplayMessageContent, getFileWriteTarget, getMessageDisplayKind, getSelectedMessageContexts, getToolActivityPresentation, getToolActivityTarget, getToolProcessingLabel, isFileWriteTool, parseMessageEventBlocks, parseTimelineJson, resolveSkillDisplayName, type SkillNameMap } from "../lib/conversation-utils";
import type { ChatEventBlock, ChatEventType, SelectedMessageContext } from "../lib/conversation-utils";
import { IconChart, IconCheck, IconChecklist, IconChevronDown, IconClose, IconCode, IconCompose, IconCopy, IconEye, IconFile, IconFileChanges, IconFolder, IconGlobe, IconGpa, IconHelpCircle, IconImage, IconKnowledge, IconMcp, IconNotebook, IconSearch, IconSkills, IconTerminal, IconVideo } from "../icons";
import { CopyTextButton, MessageMediaLightbox, getFileLeafName, normalizeMarkdownImageSource, renderMarkdownDocument, type MessageMediaPreview } from "../markdown";
import { useMotionPresence } from "../core/motion-presence";
import { ApiCardThreadContext } from "../cards/api-card-message";

type ToolActivityGroupProps = {
  toolCalls: ToolCallRecord[];
  skillNames?: SkillNameMap;
};

type MessageKnowledgeSource = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  sourcePath: string;
  locator?: string;
};

type MessageBrowserSource = {
  title: string;
  url: string;
};

function formatRelativeTime(isoTime: string) {
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return "";
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export const ToolActivityGroup = memo(function ToolActivityGroup({
  toolCalls,
  skillNames
}: ToolActivityGroupProps) {
  const toolPresentation = getToolActivityPresentation(toolCalls);
  const { runningCall } = toolPresentation;
  const isRunning = Boolean(runningCall);
  const groupRef = useRef<HTMLDetailsElement>(null);
  const wasRunningRef = useRef(isRunning);
  const status = toolPresentation.status;
  const conciseLabel = runningCall
    ? getToolProcessingLabel(runningCall.toolName, runningCall.argumentsJson, skillNames)
    : getConciseToolActivityLabel(toolCalls, undefined, skillNames);

  useEffect(() => {
    if (isRunning) {
      wasRunningRef.current = true;
      return;
    }
    if (wasRunningRef.current) {
      wasRunningRef.current = false;
      groupRef.current?.removeAttribute("open");
    }
  }, [isRunning, runningCall?.id]);

  return (
    <details ref={groupRef} className={`tool-activity-group ${status}`}>
      <summary
        className="tool-activity-summary"
        aria-label={`${conciseLabel}：${isRunning ? "执行中" : status === "failed" ? "部分失败" : status === "blocked" ? "已拦截" : "已完成"}，${toolCalls.length} 项`}
      >
        <span className="tool-activity-summary-icon" aria-hidden><ToolActivityIcon toolName={toolCalls[0]?.toolName ?? ""} /></span>
        <span className="tool-activity-summary-copy"><strong>{conciseLabel}</strong></span>
        <span className={`tool-activity-summary-status ${status}`}>{isRunning ? "执行中" : status === "failed" ? "部分失败" : status === "blocked" ? "已拦截" : "已完成"}</span>
        <span className="tool-activity-summary-count">{toolCalls.length} 项</span>
        <span className="tool-activity-chevron" aria-hidden />
      </summary>
      <div className="tool-activity-details-shell">
        <div className="tool-activity-details">
          {toolCalls.map((toolCall) => <ToolActivityRow key={toolCall.id} toolCall={toolCall} compact skillNames={skillNames} />)}
        </div>
      </div>
    </details>
  );
}, (previous, next) => previous.skillNames === next.skillNames && areToolActivityGroupsEqual(previous.toolCalls, next.toolCalls));

function areToolActivityGroupsEqual(previous: ToolCallRecord[], next: ToolCallRecord[]) {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((call, index) => {
    const candidate = next[index];
    return candidate?.id === call.id
      && candidate.status === call.status
      && candidate.startedAt === call.startedAt
      && candidate.completedAt === call.completedAt
      && candidate.argumentsJson === call.argumentsJson
      && candidate.resultJson === call.resultJson;
  });
}

function ToolActivityRow({ toolCall, compact = false, skillNames }: { toolCall: ToolCallRecord; compact?: boolean; skillNames?: SkillNameMap }) {
  const input = parseTimelineJson(toolCall.argumentsJson);
  const result = parseTimelineJson(toolCall.resultJson);
  const command = getTimelineCommand(toolCall.toolName, input);
  const displayCommand = toolCall.toolName === "skills.load"
    ? resolveSkillDisplayName(input.skill_id, skillNames) || command
    : command;
  const isRunning = toolCall.status === "running" || toolCall.status === "pending";
  const blocked = toolCall.status === "blocked";
  const failed = toolCall.status === "failed" || toolCall.status === "denied";
  const status = isRunning ? "in_progress" : blocked ? "blocked" : failed ? "failed" : "completed";
  const duration = toolCall.completedAt
    ? Math.max(0, Date.parse(toolCall.completedAt) - Date.parse(toolCall.startedAt))
    : null;
  const output = getTimelineOutput(result);
  const localUrl = typeof result.localUrl === "string" ? result.localUrl : null;
  const target = getToolActivityTarget(toolCall.toolName, input, command, skillNames);

  if (compact) {
    return (
      <details className={`tool-activity-row compact ${status}`}>
        <summary className={`tool-activity-compact-summary${target ? "" : " without-target"}`}>
          <span className="tool-activity-row-icon" aria-hidden><ToolActivityIcon toolName={toolCall.toolName} /></span>
          <strong>{getToolActivityLabel(toolCall.toolName)}</strong>
          {target ? <code title={target}>{target}</code> : null}
          <span className="tool-activity-compact-status">{isRunning ? "执行中" : blocked ? "已拦截" : failed ? "失败" : "完成"}</span>
          {duration !== null ? <time>{formatDuration(duration)}</time> : null}
        </summary>
        <div className="tool-activity-compact-details">
          <code>$ {displayCommand}</code>
          {localUrl ? <LocalServerPreview url={localUrl} /> : null}
          {output ? (
            <details className="tool-activity-output" open>
              <summary>{blocked ? "查看拦截原因" : failed ? "查看错误输出" : "查看输出"}</summary>
              <pre>{output}</pre>
              <MessageDetectedMediaGallery content={output} />
            </details>
          ) : isRunning ? <span className="tool-activity-row-progress">等待工具返回...</span> : null}
        </div>
      </details>
    );
  }

  return (
    <article className={`tool-activity-row ${status}`}>
      <span className="tool-activity-row-icon" aria-hidden><ToolActivityIcon toolName={toolCall.toolName} /></span>
      <div className="tool-activity-row-copy">
        <div className="tool-activity-row-head">
          <strong>{getToolActivityLabel(toolCall.toolName)}</strong>
          <span>{isRunning ? "正在执行" : blocked ? "执行前已拦截" : failed ? "执行失败" : "已完成"}</span>
          {duration !== null ? <time>{formatDuration(duration)}</time> : null}
        </div>
        <code>{isFileWriteTool(toolCall.toolName) ? getFileWriteTarget(input) : `$ ${displayCommand}`}</code>
        {localUrl ? <LocalServerPreview url={localUrl} /> : null}
        {output ? (
          <details className="tool-activity-output" open={failed || blocked}>
            <summary>{blocked ? "查看拦截原因" : failed ? "查看错误输出" : "查看输出"}</summary>
            <pre>{output}</pre>
            <MessageDetectedMediaGallery content={output} />
          </details>
        ) : isRunning ? <span className="tool-activity-row-progress">等待工具返回...</span> : null}
      </div>
    </article>
  );
}

export function ToolActivityIcon({ toolName }: { toolName: string }) {
  if (toolName === "shell.exec" || toolName === "execute_command") return <IconTerminal />;
  if (isFileWriteTool(toolName)) return <IconFileChanges />;
  if (toolName === "fs.read_file") return <IconFile />;
  if (toolName === "fs.read_directory" || toolName === "fs.mkdir") return <IconFolder />;
  if (toolName.startsWith("knowledge.") || toolName === "knowledge.search") return <IconKnowledge />;
  if (toolName.startsWith("todo.")) return <IconChecklist />;
  if (toolName === "code.search" || toolName.startsWith("code.") || toolName === "project.verify") return <IconSearch />;
  if (toolName.startsWith("git.")) return <IconCode />;
  if (toolName.startsWith("browser.") || toolName.startsWith("web_search.")) return <IconGlobe />;
  if (toolName === "image.generate") return <IconImage />;
  if (toolName === "video.generate") return <IconVideo />;
  if (toolName.startsWith("skills.")) return <IconSkills />;
  if (toolName.startsWith("mcp.") || toolName.startsWith("list_mcp_") || toolName === "read_mcp_resource" || toolName === "get_mcp_prompt") return <IconMcp />;
  if (toolName.startsWith("database.")) return <IconChart />;
  if (toolName.startsWith("memories.")) return <IconNotebook />;
  return <IconTerminal />;
}

export function getConciseToolActivityLabel(toolCalls: ToolCallRecord[], runningCall?: ToolCallRecord, skillNames?: SkillNameMap): string {
  if (runningCall) {
    return getToolProcessingLabel(
      runningCall.toolName,
      runningCall.toolName === "skills.load" ? runningCall.argumentsJson : undefined,
      skillNames
    );
  }

  const has = (toolName: string) => toolCalls.some((toolCall) => toolCall.toolName === toolName);
  const hasPrefix = (prefix: string) => toolCalls.some((toolCall) => toolCall.toolName.startsWith(prefix));
  const countMatching = (predicate: (toolCall: ToolCallRecord) => boolean) => toolCalls.filter(predicate).length;

  const writeCount = countMatching((toolCall) => isFileWriteTool(toolCall.toolName));
  const commandCount = countMatching((toolCall) =>
    toolCall.toolName === "shell.exec" || toolCall.toolName === "execute_command"
  );
  const fileReadCount = countMatching((toolCall) =>
    toolCall.toolName === "fs.read_file" || toolCall.toolName === "fs.read_directory"
  );
  const browserOnly = toolCalls.some((toolCall) => toolCall.toolName.startsWith("browser."));
  const loadedSkillIds = [...new Set(
    toolCalls
      .filter((toolCall) => toolCall.toolName === "skills.load")
      .map((toolCall) => parseTimelineJson(toolCall.argumentsJson).skill_id)
      .filter((skillId): skillId is string => typeof skillId === "string" && skillId.trim().length > 0)
  )];
  const loadedSkillNames = loadedSkillIds.map((skillId) => resolveSkillDisplayName(skillId, skillNames));
  const labels = [
    writeCount ? "编辑了文件" : "",
    commandCount ? (commandCount > 1 ? "运行了多个命令" : "运行了命令") : "",
    !writeCount && fileReadCount ? (fileReadCount > 1 ? "查看了多个文件" : "查看了文件") : "",
    has("code.search") ? "代码搜索" : "",
    has("code.diagnostics") || has("project.verify") ? "验证项目" : "",
    has("knowledge.search") ? "知识库搜索" : "",
    has("knowledge.read") ? "读取知识库" : "",
    has("knowledge.add") ? "写入知识库" : "",
    has("todo.write") || has("todo.read") ? "更新任务清单" : "",
    hasPrefix("git.") ? "Git 操作" : "",
    has("web_search.search_query") ? "浏览器搜索" : "",
    has("web_search.open_page") ? "打开网页" : "",
    has("web_search.find_in_page") ? "页内查找" : "",
    has("image.generate") ? "生成图片" : "",
    has("video.generate") ? "生成视频" : "",
    hasPrefix("database.") ? "查询数据库" : "",
    hasPrefix("memories.") ? "搜索记忆" : "",
    hasPrefix("skills.") ? (loadedSkillNames.length ? `加载技能 ${loadedSkillNames.slice(0, 3).join("、")}` : "加载技能") : "",
    has("mcp.call") || has("mcp.list_tools") || has("list_mcp_resources") || has("list_mcp_resource_templates") ? "调用 MCP" : "",
    !has("web_search.search_query") && !has("web_search.open_page") && !has("web_search.find_in_page") && browserOnly ? "浏览了网页" : ""
  ].filter(Boolean);

  return labels.slice(0, 2).join("，") || "完成了多个操作";
}

function getLegacyToolActivitySummary(toolCalls: ToolCallRecord[], runningCall?: ToolCallRecord) {
  if (runningCall) {
    const input = parseTimelineJson(runningCall.argumentsJson);
    return {
      title: getToolProcessingLabel(runningCall.toolName),
      detail: isFileWriteTool(runningCall.toolName) ? getFileWriteTarget(input) : getTimelineCommand(runningCall.toolName, input)
    };
  }

  const commandCount = toolCalls.filter((toolCall) => toolCall.toolName === "shell.exec" || toolCall.toolName === "execute_command").length;
  const fileCount = toolCalls.filter((toolCall) => isFileWriteTool(toolCall.toolName)).length;
  const failed = toolCalls.some((toolCall) => toolCall.status === "failed" || toolCall.status === "denied");

  if (failed) return { title: "部分步骤执行失败", detail: `${toolCalls.length} 个操作` };
  if (fileCount && commandCount) return { title: `编辑了 ${fileCount} 个文件，运行了 ${commandCount} 个命令` };
  if (commandCount) return { title: commandCount === 1 ? "运行了 1 个命令" : `运行了 ${commandCount} 个命令` };
  if (fileCount) return { title: fileCount === 1 ? "编辑了 1 个文件" : `编辑了 ${fileCount} 个文件` };
  return { title: toolCalls.length === 1 ? getToolActivityLabel(toolCalls[0]?.toolName ?? "") : `调用了 ${toolCalls.length} 个工具` };
}

function getToolActivityLabel(toolName: string) {
  if (toolName === "shell.exec" || toolName === "execute_command") return "运行命令";
  if (toolName === "fs.read_file") return "读取文件";
  if (toolName === "fs.read_directory") return "读取目录";
  if (toolName === "fs.mkdir") return "创建目录";
  if (toolName === "fs.rename") return "重命名文件";
  if (toolName === "fs.delete") return "删除文件";
  if (toolName === "fs.copy") return "复制文件";
  if (isFileWriteTool(toolName)) return "写入文件";
  if (toolName === "code.search") return "代码搜索";
  if (toolName === "code.outline") return "查看代码大纲";
  if (toolName === "code.ast_diff") return "对比代码";
  if (toolName === "code.diagnostics") return "读取诊断";
  if (toolName === "knowledge.search") return "知识库搜索";
  if (toolName === "knowledge.read") return "读取知识库";
  if (toolName === "knowledge.add") return "写入知识库";
  if (toolName === "todo.read") return "查看任务清单";
  if (toolName === "todo.write") return "更新任务清单";
  if (toolName === "web_search.search_query") return "浏览器搜索";
  if (toolName === "web_search.open_page") return "打开网页";
  if (toolName === "web_search.find_in_page") return "页内查找";
  if (toolName.startsWith("browser.")) return "操作浏览器";
  if (toolName === "image.generate") return "生成图片";
  if (toolName === "video.generate") return "生成视频";
  if (toolName === "database.query" || toolName === "database.federated_query") return "查询数据库";
  if (toolName === "database.insert") return "插入数据库";
  if (toolName === "database.update") return "更新数据库";
  if (toolName === "database.delete") return "删除数据库记录";
  if (toolName === "database.describe_schema") return "查看数据库结构";
  if (toolName === "database.list_sources") return "查看数据源";
  if (toolName.startsWith("database.")) return "操作数据库";
  if (toolName === "memories.search") return "搜索记忆";
  if (toolName === "memories.list") return "查看记忆";
  if (toolName === "memories.add_ad_hoc_note") return "记录记忆";
  if (toolName === "skills.load") return "加载技能";
  if (toolName === "skills.install") return "安装技能";
  if (toolName === "mcp.call") return "调用 MCP";
  if (toolName === "mcp.list_tools") return "查看 MCP 工具";
  if (toolName === "mcp.install") return "安装 MCP";
  if (toolName === "list_mcp_resources" || toolName === "list_mcp_resource_templates") return "查看 MCP 资源";
  if (toolName === "read_mcp_resource") return "读取 MCP 资源";
  if (toolName === "project.verify") return "验证项目";
  if (toolName === "git.commit") return "创建提交";
  if (toolName === "git.stage_file" || toolName === "git.stage_all") return "暂存变更";
  if (toolName === "git.unstage_file") return "取消暂存";
  if (toolName === "git.revert_file") return "撤销文件修改";
  if (toolName === "git.apply_hunk") return "应用修改块";
  if (toolName === "git.push") return "推送分支";
  if (toolName === "git.pull") return "拉取远端";
  if (toolName === "git.create_pr") return "创建 Pull Request";
  if (toolName.startsWith("git.")) return "检查 Git";
  return formatToolName(toolName);
}

export function LocalServerPreview({ url }: { url: string }) {
  return (
    <section className="local-server-preview">
      <span className="local-server-preview-icon" aria-hidden="true"><IconGlobe /></span>
      <span className="local-server-preview-copy">
        <strong>网页预览</strong>
        <span>{url}</span>
      </span>
      <button type="button" onClick={() => void window.codexh.openExternal(url)}>
        打开网页
      </button>
    </section>
  );
}

function InteractionCountdown({ expiresAt, timeoutLabel }: { expiresAt: string | null | undefined; timeoutLabel: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000));
  return <small className="interaction-countdown">{seconds > 0 ? `${seconds} 秒${timeoutLabel}` : "正在自动处理..."}</small>;
}

export function ApprovalCard({
  approval,
  resolving,
  onResolve
}: {
  approval: ApprovalRequest;
  resolving: boolean;
  onResolve: (decision: "approved" | "denied", mode?: "once" | "session" | "remember") => void;
}) {
  return (
    <section id={`approval-card-${approval.id}`} className="approval-card" aria-label={`审批请求: ${approval.title}`}>
      <div className="approval-card-copy">
        <span className="approval-card-label">需要审批</span>
        <strong>{approval.title}</strong>
        <p>{approval.description}</p>
        <InteractionCountdown expiresAt={approval.expiresAt} timeoutLabel="后将自动拒绝" />
      </div>
      <div className="approval-card-actions">
        <button type="button" className="approval-deny-button" disabled={resolving} onClick={() => onResolve("denied")}>
          拒绝
        </button>
        <button type="button" className="approval-session-button" disabled={resolving} onClick={() => onResolve("approved", "session")}>
          本会话允许
        </button>
        <button type="button" className="approval-remember-button" disabled={resolving} onClick={() => onResolve("approved", "remember")}>
          允许且不再询问
        </button>
        <button type="button" className="approval-allow-button" disabled={resolving} onClick={() => onResolve("approved", "once")}>
          {resolving ? "处理中..." : "允许并继续"}
        </button>
      </div>
    </section>
  );
}

export function UserInputPromptCard({
  prompt,
  resolving,
  canAnswer,
  onAnswer
}: {
  prompt: UserInputPrompt;
  resolving: boolean;
  canAnswer: boolean;
  onAnswer: (answers: Record<string, string>) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [resolvedPlanExpanded, setResolvedPlanExpanded] = useState(false);
  const pending = prompt.status === "pending";
  const canSubmit = prompt.questions.every((question) => {
    const hasOptions = (question.options?.length ?? 0) > 0;
    return !hasOptions || !!selected[question.id] || !!notes[question.id]?.trim();
  });

  if (!pending) {
    if (prompt.kind === "gpa_plan_clarification") {
      const answers = prompt.questions.map((question) => {
        const rawAnswer = prompt.answers?.[question.id] ?? "";
        const selectedOption = question.options?.find((option) => option.id === rawAnswer);
        const note = prompt.answers?.[`${question.id}__note`]?.replace(/^__note__:/, "").trim();
        return {
          id: question.id,
          question: question.prompt.trim() || question.label,
          answer: rawAnswer === "__skip__"
            ? "保持原计划"
            : (selectedOption?.label ?? rawAnswer.replace(/^__custom__:/, "")) || "未选择",
          note
        };
      });
      const detailsId = `gpa-plan-answers-${prompt.id}`;
      return (
        <section className={`user-input-prompt-card resolved gpa-plan-answers ${resolvedPlanExpanded ? "is-expanded" : "is-collapsed"}`} aria-label={`已询问 ${answers.length} 个问题`}>
          <button
            type="button"
            className="gpa-plan-answers-toggle"
            aria-expanded={resolvedPlanExpanded}
            aria-controls={detailsId}
            onClick={() => setResolvedPlanExpanded((current) => !current)}
          >
            <span className="gpa-plan-answers-icon" aria-hidden><IconChecklist /></span>
            <span>已询问 {answers.length} 个问题</span>
            {resolvedPlanExpanded ? <IconChevronDown /> : null}
          </button>
          {resolvedPlanExpanded ? (
            <div id={detailsId} className="gpa-plan-answers-details">
              {answers.map((entry) => (
                <div key={entry.id} className="gpa-plan-answer">
                  <span className="gpa-plan-answer-question">{entry.question}</span>
                  <span className="gpa-plan-answer-value">{entry.answer}</span>
                  {entry.note ? <span className="gpa-plan-answer-note">{entry.note}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      );
    }
    const skipped = Object.values(prompt.answers ?? {}).includes("__skip__");
    const firstQuestion = prompt.questions[0];
    const rawAnswer = firstQuestion ? prompt.answers?.[firstQuestion.id] ?? "" : "";
    const selectedLabel = firstQuestion?.options?.find((option) => option.id === rawAnswer)?.label;
    const summary = selectedLabel ?? rawAnswer.replace(/^__custom__:/, "");
    return (
      <section className="user-input-prompt-card resolved" aria-label={`${prompt.title} 已处理`}>
        <span className="user-input-prompt-resolved-mark" aria-hidden><IconCheck /></span>
        <span>已提供输入</span>
        <strong>{skipped ? "保持原计划" : summary || "已提交"}</strong>
      </section>
    );
  }

  if (!canAnswer) {
    return (
      <section className="user-input-prompt-card resolved interrupted" aria-label={`${prompt.title} 已中断`}>
        <span className="user-input-prompt-resolved-mark" aria-hidden><IconClose /></span>
        <span>该问题所属任务已中断</span>
        <strong>请重新开始后再决定</strong>
      </section>
    );
  }

  return (
    <section id={`user-input-prompt-${prompt.id}`} className={`user-input-prompt-card ${prompt.kind}`} aria-label={prompt.title}>
      <header className="user-input-prompt-head">
        <span className="user-input-prompt-icon" aria-hidden><IconHelpCircle /></span>
        <strong>{prompt.title}</strong>
        <InteractionCountdown expiresAt={prompt.expiresAt} timeoutLabel="后将自动执行默认操作" />
      </header>
      <div className="user-input-prompt-questions">
        {prompt.questions.map((question, index) => (
          <fieldset key={question.id} className="user-input-question" disabled={resolving}>
            <legend>{prompt.questions.length > 1 ? `${index + 1}. ${question.label}` : question.label}</legend>
            <p>{question.prompt}</p>
            {question.options?.length ? (
              <div className="user-input-options">
                {question.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`user-input-option ${selected[question.id] === option.id ? "selected" : ""}`}
                    onClick={() => setSelected((current) => ({ ...current, [question.id]: option.id }))}
                  >
                    <span className="user-input-option-marker" aria-hidden>{selected[question.id] === option.id ? "●" : "○"}</span>
                    <span className="user-input-option-copy">
                      <strong>{option.label}</strong>
                      {option.description ? <small>{option.description}</small> : null}
                    </span>
                    {option.recommended ? <em>推荐</em> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {(question.allowFreeText || !question.options?.length) ? (
              <textarea
                value={notes[question.id] ?? ""}
                onChange={(event) => setNotes((current) => ({ ...current, [question.id]: event.target.value }))}
                placeholder="补充你的决定或其他方案"
                rows={2}
              />
            ) : null}
          </fieldset>
        ))}
      </div>
      <footer className="user-input-prompt-actions">
        {prompt.allowSkip ? (
          <button type="button" className="user-input-skip" disabled={resolving} onClick={() => onAnswer({ [prompt.questions[0]?.id ?? "decision"]: "__skip__" })}>
            跳过
          </button>
        ) : <span />}
        <button
          type="button"
          className="user-input-submit"
          disabled={resolving || !canSubmit}
          onClick={() => {
            const answers: Record<string, string> = {};
            for (const question of prompt.questions) {
              const note = notes[question.id]?.trim();
              answers[question.id] = selected[question.id] || (note ? `__custom__:${note}` : "");
              if (note && selected[question.id]) answers[`${question.id}__note`] = `__note__:${note}`;
            }
            onAnswer(answers);
          }}
        >
          {resolving ? "提交中..." : "确认选择"}
        </button>
      </footer>
    </section>
  );
}

export function getTimelineCommand(toolName: string, input: Record<string, unknown>): string {
  const command = input.command ?? input.filePath ?? input.path ?? input.query ?? input.skill_id;
  return typeof command === "string" && command.trim() ? command : toolName;
}

export function getTimelineOutput(result: Record<string, unknown>): string {
  const content = result.content;
  if (typeof content === "string") return content;
  return Object.keys(result).length > 0 ? JSON.stringify(result, null, 2) : "";
}

export function formatToolName(name: string): string {
  return name.replace(/[._-]+/g, " ");
}

export function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function renderRole(role: string, assistantLabel = "Assistant") {
  switch (role) {
    case "assistant":
      return assistantLabel;
    case "user":
      return "User";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    default:
      return role;
  }
}

export type UserMessageActions = {
  editingMessage: { id: string; content: string } | null;
  onEditDraftChange: (content: string) => void;
  onCopy: (content: string) => void;
  onEdit: (message: MessageRecord) => void;
  onEditCancel: () => void;
  onEditSubmit: () => void;
};

type TranscriptMessageProps = {
  message: MessageRecord;
  assistantLabel: string;
  userMessageActions: UserMessageActions;
  isGpaPlanMessage?: boolean;
  isFinalizingFromDraft?: boolean;
};

type AssistantDraftMessageProps = {
  assistantLabel: string;
  content: string;
  draftId: string;
  phase: AssistantDraftPhase;
  startedAt: string;
  completed: boolean;
};

export const AssistantDraftMessage = memo(function AssistantDraftMessage({
  assistantLabel,
  content,
  draftId,
  phase,
  startedAt,
  completed
}: AssistantDraftMessageProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followsLatestRef = useRef(true);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !followsLatestRef.current) return;
    scrollElement.scrollTop = scrollElement.scrollHeight;
  }, [content]);

  // The runtime activity panel owns live execution status. Whitespace-only
  // chunks should not create a duplicate, empty streaming message.
  if (!content.trim()) return null;

  return (
    <article className={`message-card assistant streaming-assistant is-provisional phase-${phase}`} aria-live="polite" aria-busy={!completed}>
      <div className="message-header">
        <span className="message-author assistant">{assistantLabel}</span>
      </div>
      <div className="message-flat-body streaming-assistant-body">
        <div
          className="assistant-draft-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            followsLatestRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 4;
          }}
        >
          <span className="streaming-assistant-plain-body" data-draft-id={draftId}>{content}</span>
          {phase === "generating" ? <span className="streaming-caret" aria-hidden /> : null}
        </div>
      </div>
    </article>
  );
});

export const TranscriptMessage = memo(function TranscriptMessage({
  message,
  assistantLabel,
  userMessageActions,
  isGpaPlanMessage = false,
  isFinalizingFromDraft = false
}: TranscriptMessageProps) {
  const gpaTaskProgress = getGpaTaskProgress(message);
  if (gpaTaskProgress) {
    return <GpaTaskProgressMessage message={message} task={gpaTaskProgress} />;
  }
  const displayContent = getDisplayMessageContent(message);
  if (message.role === "assistant" && !displayContent.trim()) {
    return null;
  }

  if (message.role === "user") {
    return (
      <article
        id={`transcript-message-${message.id}`}
        className={`message-card user${message.id.startsWith("optimistic-") ? " is-sending" : ""}`}
      >
        {renderMessageContent(message, displayContent, userMessageActions)}
      </article>
    );
  }

  return (
    <article
      id={`transcript-message-${message.id}`}
      className={`message-card ${message.role}${getMessageDisplayKind(message) === "commentary" ? " commentary" : ""}${isFinalizingFromDraft ? " is-finalizing-from-draft" : ""}`}
    >
      <div className="message-header">
        <span className={`message-author ${message.role}`}>{renderRole(message.role, assistantLabel)}</span>
        <span className="timestamp">{formatRelativeTime(message.createdAt)}</span>
      </div>
      <ApiCardThreadContext.Provider value={message.threadId}>
        <div className="message-flat-body">
          {isGpaPlanMessage ? (
            <GpaPlanMessageBubble>{renderMessageContent(message, displayContent)}</GpaPlanMessageBubble>
          ) : renderMessageContent(message, displayContent)}
        </div>
      </ApiCardThreadContext.Provider>
    </article>
  );
}, areTranscriptMessagePropsEqual);

function areTranscriptMessagePropsEqual(
  previous: Readonly<TranscriptMessageProps>,
  next: Readonly<TranscriptMessageProps>
): boolean {
  if (
    previous.assistantLabel !== next.assistantLabel ||
    previous.isGpaPlanMessage !== next.isGpaPlanMessage ||
    previous.isFinalizingFromDraft !== next.isFinalizingFromDraft
  ) {
    return false;
  }
  const previousMessage = previous.message;
  const nextMessage = next.message;
  if (previousMessage !== nextMessage) {
    const previousKeys = Object.keys(previousMessage) as Array<keyof MessageRecord>;
    const nextKeys = Object.keys(nextMessage) as Array<keyof MessageRecord>;
    if (previousKeys.length !== nextKeys.length || previousKeys.some((key) => previousMessage[key] !== nextMessage[key])) {
      return false;
    }
  }
  return previousMessage.role !== "user" || previous.userMessageActions === next.userMessageActions;
}

export function reuseEquivalentRecordArray<T extends object>(previous: T[], next: T[]): T[] {
  if (previous === next || previous.length !== next.length) {
    return next;
  }

  for (let index = 0; index < previous.length; index += 1) {
    const previousItem = previous[index] as Record<string, unknown>;
    const nextItem = next[index] as Record<string, unknown>;
    const previousKeys = Object.keys(previousItem);
    const nextKeys = Object.keys(nextItem);
    if (
      previousKeys.length !== nextKeys.length ||
      previousKeys.some((key) => previousItem[key] !== nextItem[key])
    ) {
      return next;
    }
  }

  return previous;
}

export type GpaTaskProgress = {
  taskId: string;
  taskTitle: string;
};

function getGpaTaskProgress(message: MessageRecord): GpaTaskProgress | null {
  if (message.role !== "assistant" || !message.metadataJson) return null;
  try {
    const metadata = JSON.parse(message.metadataJson) as {
      displayKind?: unknown;
      taskId?: unknown;
      taskTitle?: unknown;
      status?: unknown;
    };
    if (
      metadata.displayKind !== "gpa-task-progress" ||
      metadata.status !== "completed" ||
      typeof metadata.taskId !== "string" ||
      typeof metadata.taskTitle !== "string"
    ) {
      return null;
    }
    return { taskId: metadata.taskId, taskTitle: metadata.taskTitle };
  } catch {
    return null;
  }
}

function GpaTaskProgressMessage({ message, task }: { message: MessageRecord; task: GpaTaskProgress }) {
  return (
    <article key={message.id} className="gpa-task-progress-message" aria-label={`${task.taskId} 已完成`}>
      <span className="gpa-task-progress-icon" aria-hidden><IconCheck /></span>
      <span className="gpa-task-progress-copy"><strong>{task.taskId}</strong><span>{task.taskTitle}</span></span>
      <span className="gpa-task-progress-status">已完成</span>
      <span className="gpa-task-progress-time">{formatRelativeTime(message.createdAt)}</span>
    </article>
  );
}

function GpaPlanMessageBubble({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <section className={`gpa-plan-message ${expanded ? "is-expanded" : "is-collapsed"}`} aria-label="GPA 计划">
      <header className="gpa-plan-message-head">
        <span className="gpa-plan-message-title"><IconGpa />GPA 计划</span>
        <button
          type="button"
          className="gpa-plan-message-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "收起 GPA 计划" : "展开 GPA 计划"}
          title={expanded ? "收起 GPA 计划" : "展开 GPA 计划"}
          onClick={() => setExpanded((current) => !current)}
        >
          <IconChevronDown />
        </button>
      </header>
      {expanded ? <div className="gpa-plan-message-content">{children}</div> : null}
    </section>
  );
}

function renderMessageContent(
  message: MessageRecord,
  content = message.content,
  userMessageActions?: UserMessageActions
) {
  const attachments = getMessageAttachments(message);
  if (message.role === "user") {
    if (!userMessageActions) {
      return (
        <div className="message-user-content">
          <div className="message-user-bubble">
            {content ? <div className="message-user-text">{content}</div> : null}
            <MessageSelectedContextChips content={message.content} />
            <MessageAttachmentGallery threadId={message.threadId} attachments={attachments} />
          </div>
        </div>
      );
    }

    const editingMessage =
      userMessageActions.editingMessage?.id === message.id ? userMessageActions.editingMessage : null;
    return (
      <div className={`message-user-content ${editingMessage ? "is-editing" : ""}`}>
        <div className="message-user-bubble">
          {editingMessage ? (
            <>
              <div className="message-user-edit-head">
                <IconCompose />
                <span>编辑消息</span>
              </div>
              <textarea
                className="message-user-edit-input"
                value={editingMessage.content}
                onChange={(event) => userMessageActions.onEditDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault();
                    userMessageActions.onEditSubmit();
                  }
                }}
                aria-label="编辑已发送的消息"
                autoFocus
              />
              <div className="message-user-edit-actions">
                <button type="button" className="message-user-edit-button" onClick={userMessageActions.onEditCancel}>
                  取消
                </button>
                <button
                  type="button"
                  className="message-user-edit-button primary"
                  onClick={userMessageActions.onEditSubmit}
                  disabled={!editingMessage.content.trim()}
                >
                  发送
                </button>
              </div>
            </>
          ) : (
            <>
              {content ? <div className="message-user-text">{content}</div> : null}
              <MessageSelectedContextChips content={message.content} />
              <MessageAttachmentGallery threadId={message.threadId} attachments={attachments} />
            </>
          )}
        </div>
        {!editingMessage ? (
          <div className="message-user-actions" aria-label="消息操作">
            <button
              type="button"
              title="复制消息"
              aria-label="复制消息"
              onClick={() => userMessageActions.onCopy(content)}
            >
              <IconCopy />
            </button>
            <button
              type="button"
              title="重新编辑消息"
              aria-label="重新编辑消息"
              onClick={() => userMessageActions.onEdit(message)}
            >
              <IconCompose />
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const eventBlocks = parseMessageEventBlocks({ ...message, content });
  const knowledgeSources = message.role === "assistant" ? getMessageKnowledgeSources(message) : [];
  const browserSources = message.role === "assistant" ? getMessageBrowserSources(message) : [];
  if (!eventBlocks || eventBlocks.length === 0) {
    return <>
      {renderMarkdownDocument(content, `${message.id}-markdown`, "message-markdown")}
      {message.role === "assistant" ? <MessageDetectedMediaGallery content={content} /> : null}
      <MessageAttachmentGallery threadId={message.threadId} attachments={attachments} />
      <MessageKnowledgeSources sources={knowledgeSources} />
      <MessageBrowserSources sources={browserSources} />
    </>;
  }

  return (
    <div className="message-event-stream">
      {eventBlocks.map((block, index) => renderEventBlock(block, `${message.id}-${block.type}-${index}`))}
      {message.role === "assistant" ? <MessageDetectedMediaGallery content={content} /> : null}
      <MessageAttachmentGallery threadId={message.threadId} attachments={attachments} />
      <MessageKnowledgeSources sources={knowledgeSources} />
      <MessageBrowserSources sources={browserSources} />
    </div>
  );
}

function getMessageKnowledgeSources(message: MessageRecord): MessageKnowledgeSource[] {
  try {
    const sources = JSON.parse(message.metadataJson ?? "{}").knowledgeSources;
    if (!Array.isArray(sources)) return [];
    return sources.filter((source): source is MessageKnowledgeSource =>
      Boolean(source) &&
      typeof source.knowledgeBaseId === "string" &&
      typeof source.knowledgeBaseName === "string" &&
      typeof source.sourcePath === "string"
    );
  } catch {
    return [];
  }
}

function MessageKnowledgeSources({ sources }: { sources: MessageKnowledgeSource[] }) {
  if (sources.length === 0) return null;
  const byKnowledgeBase = new Map<string, MessageKnowledgeSource[]>();
  for (const source of sources) {
    byKnowledgeBase.set(source.knowledgeBaseId, [...(byKnowledgeBase.get(source.knowledgeBaseId) ?? []), source]);
  }
  return (
    <div className="message-knowledge-sources" aria-label="知识库来源">
      {[...byKnowledgeBase.values()].map((entries) => {
        const [source] = entries;
        const locations = entries.map((item) => `${item.sourcePath}${item.locator ? ` (${item.locator})` : ""}`).join("\n");
        return (
          <span key={source.knowledgeBaseId} className="message-knowledge-source" title={`知识库来源\n${locations}`}>
            <IconKnowledge />
            <span>知识库来源 · {source.knowledgeBaseName}</span>
          </span>
        );
      })}
    </div>
  );
}

function getMessageBrowserSources(message: MessageRecord): MessageBrowserSource[] {
  try {
    const sources = JSON.parse(message.metadataJson ?? "{}").browserSources;
    if (!Array.isArray(sources)) return [];
    return sources.filter((source): source is MessageBrowserSource =>
      Boolean(source) &&
      typeof source.title === "string" &&
      typeof source.url === "string" &&
      /^https?:\/\//i.test(source.url)
    );
  } catch {
    return [];
  }
}

const COLLAPSED_BROWSER_SOURCE_COUNT = 6;

function MessageBrowserSources({ sources }: { sources: MessageBrowserSource[] }) {
  const [expanded, setExpanded] = useState(false);
  if (sources.length === 0) return null;
  const hiddenCount = Math.max(0, sources.length - COLLAPSED_BROWSER_SOURCE_COUNT);
  const visibleSources = expanded ? sources : sources.slice(0, COLLAPSED_BROWSER_SOURCE_COUNT);
  return (
    <div className="message-browser-sources" aria-label="网页来源">
      {visibleSources.map((source) => (
        <a
          key={source.url}
          className="message-browser-source"
          href={source.url}
          title={`网页来源\n${source.title}\n${source.url}`}
          onClick={(event) => {
            event.preventDefault();
            void window.codexh.openExternal(source.url);
          }}
        >
          <IconGlobe />
          <span>网页来源 · {source.title}</span>
        </a>
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          className={`message-browser-sources-toggle${expanded ? " is-expanded" : ""}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span>{expanded ? "收起来源" : `展开 ${hiddenCount} 个来源`}</span>
          <IconChevronDown />
        </button>
      ) : null}
    </div>
  );
}

export function getMessageAttachments(message: MessageRecord): MessageAttachment[] {
  try {
    const attachments = JSON.parse(message.metadataJson ?? "{}").attachments;
    return Array.isArray(attachments) ? attachments as MessageAttachment[] : [];
  } catch {
    return [];
  }
}

function isVideoAttachment(attachment: MessageAttachment): boolean {
  if (attachment.kind === "video") return true;
  if (attachment.mimeType?.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|mkv)$/i.test(attachment.name || attachment.absolutePath || "");
}

function MessageAttachmentGallery({ threadId, attachments }: { threadId: string; attachments: MessageAttachment[] }) {
  const [preview, setPreview] = useState<MessageMediaPreview | null>(null);
  const previewPresence = useMotionPresence(preview);
  const visiblePreview = preview ?? previewPresence.value;
  if (attachments.length === 0) return null;
  const mediaCount = attachments.filter((attachment) => attachment.kind === "image" || isVideoAttachment(attachment)).length;
  return (
    <>
      <div className={`message-attachment-gallery ${mediaCount > 1 ? "image-grid" : ""}`}>
        {attachments.map((attachment) => {
          if (attachment.kind === "image") {
            return (
              <MessageAttachmentImage
                key={attachment.id}
                threadId={threadId}
                attachment={attachment}
                onPreview={(source) => setPreview({
                  source,
                  name: attachment.name,
                  kind: "image",
                  localPath: attachment.absolutePath
                })}
              />
            );
          }
          if (isVideoAttachment(attachment)) {
            return (
              <MessageAttachmentVideo
                key={attachment.id}
                threadId={threadId}
                attachment={attachment}
                onExpand={(source) => setPreview({
                  source,
                  name: attachment.name,
                  kind: "video",
                  localPath: attachment.absolutePath
                })}
              />
            );
          }
          return (
            <button
              key={attachment.id}
              type="button"
              className="message-file-attachment"
              title={`打开文件：${attachment.absolutePath}`}
              onClick={() => void window.codexh.openPath(attachment.absolutePath)}
            >
              <IconFile />{attachment.name}
            </button>
          );
        })}
      </div>
      {visiblePreview ? <MessageMediaLightbox preview={visiblePreview} motionPhase={previewPresence.phase} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

function MessageAttachmentImage({
  threadId,
  attachment,
  onPreview
}: {
  threadId: string;
  attachment: MessageAttachment;
  onPreview: (source: string) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.codexh.previewAttachment({ threadId, absolutePath: attachment.absolutePath })
      .then((value) => { if (!cancelled) setSource(value); })
      .catch(() => { if (!cancelled) setSource(null); });
    return () => { cancelled = true; };
  }, [attachment.absolutePath, threadId]);
  return (
    <button className="message-image-attachment" type="button" title={`查看原图：${attachment.name}`} onClick={() => source && onPreview(source)}>
      {source ? <img src={source} alt={attachment.name} /> : <span><IconImage />{attachment.name}</span>}
    </button>
  );
}

function MessageAttachmentVideo({
  threadId,
  attachment,
  onExpand
}: {
  threadId: string;
  attachment: MessageAttachment;
  onExpand: (source: string) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.codexh.getAttachmentMediaUrl({ threadId, absolutePath: attachment.absolutePath })
      .then((value) => {
        if (cancelled) return;
        if (value.kind !== "video") {
          setError("无法预览该视频");
          return;
        }
        setSource(value.url);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [attachment.absolutePath, threadId]);

  if (error) {
    return (
      <button
        type="button"
        className="message-file-attachment"
        title={error}
        onClick={() => void window.codexh.openPath(attachment.absolutePath)}
      >
        <IconVideo />{attachment.name}
      </button>
    );
  }

  return (
    <div className="message-video-attachment">
      <div className="message-video-attachment-head">
        <span title={attachment.name}><IconVideo />{attachment.name}</span>
        <div>
          <button
            type="button"
            title="放大播放"
            aria-label="放大播放"
            disabled={!source}
            onClick={() => source && onExpand(source)}
          >
            <IconEye />
          </button>
          <button
            type="button"
            title="打开本地文件"
            aria-label="打开本地文件"
            onClick={() => void window.codexh.openPath(attachment.absolutePath)}
          >
            <IconFolder />
          </button>
        </div>
      </div>
      {source ? (
        <video className="message-video-player" src={source} controls playsInline preload="metadata" />
      ) : (
        <div className="message-video-loading">正在加载视频…</div>
      )}
    </div>
  );
}

type MessageMediaReference = { source: string; kind: "local" | "url" };

export function MessageDetectedMediaGallery({ content }: { content: string }) {
  const references = extractMessageMediaReferences(content);
  const [preview, setPreview] = useState<MessageMediaPreview | null>(null);
  const previewPresence = useMotionPresence(preview);
  const visiblePreview = preview ?? previewPresence.value;
  if (references.length === 0) return null;
  return (
    <>
      <div className={`message-attachment-gallery detected-media ${references.length > 1 ? "image-grid" : ""}`}>
        {references.map((reference) => (
          <DetectedMessageImage
            key={reference.source}
            reference={reference}
            onPreview={(source) => setPreview({
              source,
              name: getFileLeafName(reference.source),
              kind: "image",
              ...(reference.kind === "local" ? { localPath: reference.source } : { url: reference.source })
            })}
          />
        ))}
      </div>
      {visiblePreview ? <MessageMediaLightbox preview={visiblePreview} motionPhase={previewPresence.phase} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

function DetectedMessageImage({ reference, onPreview }: { reference: MessageMediaReference; onPreview: (source: string) => void }) {
  const [source, setSource] = useState<string | null>(reference.kind === "url" ? reference.source : null);
  useEffect(() => {
    if (reference.kind === "url") {
      setSource(reference.source);
      return;
    }
    let cancelled = false;
    void window.codexh.previewLocalImage({ absolutePath: reference.source })
      .then((value) => { if (!cancelled) setSource(value); })
      .catch(() => { if (!cancelled) setSource(null); });
    return () => { cancelled = true; };
  }, [reference]);
  if (!source) return null;
  return (
    <button className="message-image-attachment" type="button" title={`查看原图：${getFileLeafName(reference.source)}`} onClick={() => onPreview(source)}>
      <img src={source} alt={getFileLeafName(reference.source)} />
    </button>
  );
}

export function extractMessageMediaReferences(content: string): MessageMediaReference[] {
  const matches: MessageMediaReference[] = [];
  const seen = new Set<string>();
  const add = (source: string, kind: MessageMediaReference["kind"]) => {
    const normalized = source.replace(/[),.;，。；]+$/, "").trim();
    if (!normalized || seen.has(normalized)) return;
    const imageSource = kind === "url" ? normalizeMarkdownImageSource(normalized) : normalized;
    if (!imageSource || seen.has(imageSource)) return;
    seen.add(imageSource);
    matches.push({ source: imageSource, kind });
  };
  const localPattern = /[a-zA-Z]:[\\/][^\r\n<>"|?*]+?\.(?:png|jpe?g|gif|webp|bmp)/gi;
  const urlPattern = /https?:\/\/[^\s<>()]+?\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s<>()]*)?/gi;
  for (const match of content.matchAll(urlPattern)) add(match[0], "url");
  // A URL contains the substring "s://", which otherwise looks like a Windows drive path.
  const contentWithoutUrls = content.replace(urlPattern, " ");
  for (const match of contentWithoutUrls.matchAll(localPattern)) add(match[0], "local");
  return matches;
}

function renderEventBlock(block: ChatEventBlock, key: string) {
  if (block.type === "commentary") {
    return (
      <section key={key} className="event-block commentary">
        <div className="event-commentary-shell">
          <span className={`event-badge ${block.type}`}>{block.type}</span>
          <div className="event-commentary-copy">
            {renderMarkdownDocument(block.content, `${key}-markdown`, "event-commentary-markdown")}
          </div>
        </div>
      </section>
    );
  }

  if (block.type === "final") {
    return (
      <section key={key} className="event-block final">
        <div className="event-block-head">
          <span className={`event-badge ${block.type}`}>{block.type}</span>
          <span className="event-title">{block.title ?? "Outcome"}</span>
        </div>
        <div className="event-final-shell">
          {renderMarkdownDocument(block.content, `${key}-markdown`, "event-final-markdown")}
        </div>
      </section>
    );
  }

  const meta = collectEventMeta(block);

  return (
    <section key={key} className={`event-block ${block.type}`}>
      <div className="event-block-head">
        <span className={`event-badge ${block.type}`}>{block.type}</span>
        <span className="event-title">{getEventPrimaryTitle(block)}</span>
        {meta.length > 0 ? (
          <div className="event-meta-row">
            {meta.map((item) => (
              <span key={`${key}-${item.label}`} className={`event-meta-pill ${item.tone}`}>
                {item.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {renderEventDetails(block, key)}
    </section>
  );
}

function usesMonospaceEventBody(type: ChatEventType): boolean {
  return type === "tool_call" || type === "file_view" || type === "file_change";
}

function renderEventDetails(block: ChatEventBlock, key: string) {
  if (!block.content) {
    return null;
  }

  switch (block.type) {
    case "tool_call":
      return renderMonoShell(block.content, key, "event-mono");
    case "tool_result":
      return renderToolResultBody(block, key);
    case "file_view":
      return renderFileViewBody(block, key);
    case "file_change":
      return renderFileChangeBody(block, key);
    case "test_result":
      return renderTestResultBody(block, key);
    default:
      return usesMonospaceEventBody(block.type)
        ? renderMonoShell(block.content, key, "event-mono")
        : renderMarkdownDocument(block.content, `${key}-markdown`, "event-markdown");
  }
}

function renderToolResultBody(block: ChatEventBlock, key: string) {
  const sections = parseNamedSections(block.content);
  const content = sections.preview ?? sections.body;
  const remainder = sections.preview ? sections.body : "";

  return (
    <div className="event-stack">
      {content
        ? looksLikeStructuredOutput(content)
          ? renderMonoShell(content, `${key}-preview`, "event-mono")
          : renderMarkdownDocument(content, `${key}-preview`, "event-markdown")
        : null}
      {remainder ? renderMarkdownDocument(remainder, `${key}-body`, "event-markdown") : null}
    </div>
  );
}

function renderFileViewBody(block: ChatEventBlock, key: string) {
  return (
    <div className="event-stack">
      {block.path ? (
        <div className="event-path-row">
          <code>{block.path}</code>
          {typeof block.startLine === "number" ? <span className="event-inline-line">Line {block.startLine}</span> : null}
        </div>
      ) : null}
      {renderMonoShell(block.content, `${key}-file-view`, "event-mono event-code")}
    </div>
  );
}

function renderFileChangeBody(block: ChatEventBlock, key: string) {
  const sections = parseNamedSections(block.content);
  let summary = sections.summary ?? "";
  let diff = sections.diff ?? "";
  let remainder = sections.body;
  const entitiesSection = sections.entities ?? sections.symbols ?? "";

  if (!diff) {
    const extracted = splitDiffFromContent(remainder);
    summary = summary || extracted.summary;
    diff = extracted.diff;
    remainder = extracted.remainder;
  }

  const entityLines = (entitiesSection || extractEntityLines(summary) || extractEntityLines(remainder))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || /^(added|removed|modified|renamed)\b/i.test(line));

  return (
    <div className="event-stack">
      {summary ? renderMarkdownDocument(summary, `${key}-summary`, "event-markdown event-summary-markdown") : null}
      {entityLines.length > 0 ? (
        <ul className="event-entity-list">
          {entityLines.slice(0, 24).map((line) => (
            <li key={`${key}-${line}`}>{line.replace(/^- /, "")}</li>
          ))}
        </ul>
      ) : null}
      {remainder && remainder !== entitiesSection ? renderMarkdownDocument(remainder, `${key}-details`, "event-markdown") : null}
      {diff ? renderMonoShell(diff, `${key}-diff`, "event-mono event-diff") : null}
    </div>
  );
}

function extractEntityLines(text: string): string {
  if (!text) {
    return "";
  }
  const lines = text.split(/\r?\n/).filter((line) =>
    /^\s*-\s+(added|removed|modified|renamed)\b/i.test(line) ||
    /^\s*(added|removed|modified|renamed)\s+\w+/i.test(line)
  );
  return lines.join("\n");
}

function formatSymbolChange(change: string): string {
  switch (change) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

function renderTestResultBody(block: ChatEventBlock, key: string) {
  const sections = parseNamedSections(block.content);
  const summary = sections.summary || sections.body;
  const details = sections.details;

  return (
    <div className="event-stack">
      {summary ? renderMarkdownDocument(summary, `${key}-summary`, "event-markdown") : null}
      {details ? renderMonoShell(details, `${key}-details`, "event-mono") : null}
    </div>
  );
}

function renderMonoShell(content: string, key: string, className: string) {
  return (
    <div key={key} className="event-mono-shell">
      <CopyTextButton content={content} />
      <pre className={className}>{content}</pre>
    </div>
  );
}

function getEventPrimaryTitle(block: ChatEventBlock) {
  switch (block.type) {
    case "tool_call":
    case "tool_result":
    case "test_result":
      return block.name ?? block.title ?? "Task event";
    case "file_view":
    case "file_change":
      return block.path ?? block.title ?? "Workspace file";
    default:
      return block.title ?? block.type;
  }
}

function collectEventMeta(block: ChatEventBlock): Array<{ label: string; tone: string }> {
  const meta: Array<{ label: string; tone: string }> = [];

  if (block.action) {
    meta.push({ label: formatEventAction(block.action), tone: "action" });
  }

  if (block.status) {
    meta.push({ label: block.status, tone: mapStatusTone(block.status) });
  }

  if (typeof block.ok === "boolean") {
    meta.push({ label: block.ok ? "ok" : "failed", tone: block.ok ? "success" : "danger" });
  }

  if (typeof block.exitCode === "number") {
    meta.push({ label: `exit ${block.exitCode}`, tone: block.exitCode === 0 ? "neutral" : "danger" });
  }

  if (typeof block.durationMs === "number") {
    meta.push({ label: `${block.durationMs} ms`, tone: "neutral" });
  }

  if (typeof block.startLine === "number" && !block.path) {
    meta.push({ label: `L${block.startLine}`, tone: "neutral" });
  }

  return meta;
}

function formatEventAction(action: string) {
  switch (action.trim().toLowerCase()) {
    case "create":
    case "created":
      return "Created";
    case "update":
    case "updated":
    case "modify":
    case "modified":
      return "Modified";
    case "delete":
    case "deleted":
      return "Deleted";
    case "move":
    case "moved":
      return "Moved";
    default:
      return action;
  }
}

function mapStatusTone(status: string) {
  switch (status.trim().toLowerCase()) {
    case "running":
    case "queued":
    case "in_progress":
      return "running";
    case "completed":
    case "success":
      return "success";
    case "failed":
    case "error":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

function parseNamedSections(content: string) {
  const sections = new Map<string, string[]>();
  let current = "body";

  const pushLine = (key: string, value: string) => {
    const bucket = sections.get(key) ?? [];
    bucket.push(value);
    sections.set(key, bucket);
  };

  for (const line of content.split("\n")) {
    const match = line.match(/^(summary|preview|diff|details|notes|entities|symbols):\s*(.*)$/i);
    if (match) {
      current = match[1].toLowerCase();
      if (match[2]) {
        pushLine(current, match[2]);
      } else if (!sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }

    pushLine(current, line);
  }

  return {
    body: (sections.get("body") ?? []).join("\n").trim(),
    summary: (sections.get("summary") ?? []).join("\n").trim(),
    preview: (sections.get("preview") ?? []).join("\n").trim(),
    diff: (sections.get("diff") ?? []).join("\n").trim(),
    details: (sections.get("details") ?? []).join("\n").trim(),
    notes: (sections.get("notes") ?? []).join("\n").trim(),
    entities: (sections.get("entities") ?? []).join("\n").trim(),
    symbols: (sections.get("symbols") ?? []).join("\n").trim()
  };
}

function splitDiffFromContent(content: string) {
  const lines = content.split("\n");
  const diffIndex = lines.findIndex((line) => /^(@@|\+\+\+|---)/.test(line.trim()));

  if (diffIndex < 0) {
    return {
      summary: "",
      diff: "",
      remainder: content.trim()
    };
  }

  return {
    summary: lines.slice(0, diffIndex).join("\n").trim(),
    diff: lines.slice(diffIndex).join("\n").trim(),
    remainder: ""
  };
}

function looksLikeStructuredOutput(content: string) {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("```")) {
    return true;
  }

  if (trimmed.includes("\n")) {
    return true;
  }

  return /^([A-Z]:\\|\/|@@|\+\+\+|---|\$ |\> )/.test(trimmed);
}


function MessageSelectedContextChips({ content }: { content: string }) {
  const contexts = getSelectedMessageContexts(content);
  if (contexts.length === 0) return null;
  const labels: Record<SelectedMessageContext["kind"], string> = {
    skill: "Skill",
    mcp: "MCP",
    database: "数据库",
    code: "代码",
    folder: "文件夹",
    file: "文件"
  };
  const icons: Record<SelectedMessageContext["kind"], () => ReactNode> = {
    skill: IconSkills,
    mcp: IconMcp,
    database: IconMcp,
    code: IconCode,
    folder: IconFolder,
    file: IconFile
  };
  return (
    <div className="message-selected-contexts" aria-label="已选择的聊天上下文">
      {contexts.map((context) => {
        const Icon = icons[context.kind];
        return (
          <span key={`${context.kind}-${context.label}`} className={`message-selected-context-chip ${context.kind}`} title={`${labels[context.kind]}：${context.label}`}>
            <Icon />
            <span>{context.label}</span>
          </span>
        );
      })}
    </div>
  );
}
