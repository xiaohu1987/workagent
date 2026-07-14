import * as fs from "node:fs/promises";
import path from "node:path";
import type { GpaPlanTask } from "@shared-types";

export const GPA_PLAN_RELATIVE_PATH = path.join(".codexh", "gpa-plan.md");

export type GpaPlanFileStatus = "awaiting_confirmation" | "in_progress" | "completed" | "abandoned";

export interface GpaPlanFileDocument {
  status: GpaPlanFileStatus;
  threadId: string;
  updatedAt: string;
  tasks: GpaPlanTask[];
  body: string;
}

export function resolveGpaPlanFilePath(cwd: string): string {
  return path.join(cwd, GPA_PLAN_RELATIVE_PATH);
}

export function formatGpaPlanMarkdown(input: {
  status: GpaPlanFileStatus;
  threadId: string;
  updatedAt?: string;
  tasks: GpaPlanTask[];
  body?: string;
}): string {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const taskLines = input.tasks.map((task) => {
    const mark = task.done ? "x" : " ";
    return `- [${mark}] **${task.id}** ${task.title}`;
  });
  const body = (input.body ?? "").trim();
  return [
    "# GPA Plan",
    "",
    `- **status**: \`${input.status}\``,
    `- **thread_id**: \`${input.threadId}\``,
    `- **updated_at**: \`${updatedAt}\``,
    "",
    "## Tasks",
    "",
    ...(taskLines.length > 0 ? taskLines : ["- [ ] **T1** （空计划）"]),
    "",
    "## Plan Body",
    "",
    body || "_（无正文）_",
    ""
  ].join("\n");
}

export function parseGpaPlanMarkdown(content: string): GpaPlanFileDocument | null {
  const text = content.trim();
  if (!text) {
    return null;
  }

  const statusMatch = text.match(/\*\*status\*\*:\s*`([^`]+)`/i);
  const threadMatch = text.match(/\*\*thread_id\*\*:\s*`([^`]+)`/i);
  const updatedMatch = text.match(/\*\*updated_at\*\*:\s*`([^`]+)`/i);
  const statusRaw = statusMatch?.[1]?.trim() ?? "in_progress";
  const status: GpaPlanFileStatus =
    statusRaw === "completed" ||
    statusRaw === "awaiting_confirmation" ||
    statusRaw === "in_progress" ||
    statusRaw === "abandoned"
      ? statusRaw
      : "in_progress";

  const tasks: GpaPlanTask[] = [];
  const taskSection = text.split(/##\s*Tasks\b/i)[1]?.split(/##\s*Plan Body\b/i)[0] ?? text;
  for (const line of taskSection.split(/\r?\n/)) {
    const match = line.match(
      /^\s*[-*+]\s*\[([ xX])\]\s*\*\*(T\d+)\*\*\s+(.+?)\s*$/i
    );
    if (!match) {
      continue;
    }
    tasks.push({
      id: match[2].toUpperCase(),
      title: match[3].trim(),
      done: match[1].toLowerCase() === "x"
    });
  }

  if (tasks.length === 0) {
    return null;
  }

  const body = (text.split(/##\s*Plan Body\b/i)[1] ?? "").trim();

  return {
    status,
    threadId: threadMatch?.[1]?.trim() ?? "",
    updatedAt: updatedMatch?.[1]?.trim() ?? new Date().toISOString(),
    tasks,
    body
  };
}

export async function readGpaPlanFile(cwd: string): Promise<GpaPlanFileDocument | null> {
  const filePath = resolveGpaPlanFilePath(cwd);
  try {
    const content = await fs.readFile(filePath, "utf8");
    return parseGpaPlanMarkdown(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeGpaPlanFile(
  cwd: string,
  input: {
    status: GpaPlanFileStatus;
    threadId: string;
    updatedAt?: string;
    tasks: GpaPlanTask[];
    body?: string;
  }
): Promise<string> {
  const filePath = resolveGpaPlanFilePath(cwd);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const markdown = formatGpaPlanMarkdown(input);
  await fs.writeFile(filePath, markdown, "utf8");
  return filePath;
}

export function gpaPlanHasIncompleteTasks(doc: GpaPlanFileDocument | null | undefined): boolean {
  return Boolean(
    doc &&
      doc.status !== "completed" &&
      doc.status !== "abandoned" &&
      (doc.status === "awaiting_confirmation" || doc.tasks.some((task) => !task.done))
  );
}

export type GpaPlanResumePreview = {
  status: GpaPlanFileStatus;
  sourceThreadId: string;
  currentThreadId: string;
  sameSession: boolean;
  updatedAt: string;
  tasks: GpaPlanTask[];
  body: string;
  doneCount: number;
  pendingCount: number;
  pendingTasks: GpaPlanTask[];
};

export function toGpaPlanResumePreview(
  doc: GpaPlanFileDocument,
  currentThreadId: string
): GpaPlanResumePreview {
  const pendingTasks = doc.tasks.filter((task) => !task.done);
  return {
    status: doc.status,
    sourceThreadId: doc.threadId,
    currentThreadId,
    sameSession: Boolean(doc.threadId) && doc.threadId === currentThreadId,
    updatedAt: doc.updatedAt,
    tasks: doc.tasks,
    body: doc.body,
    doneCount: doc.tasks.filter((task) => task.done).length,
    pendingCount: pendingTasks.length,
    pendingTasks
  };
}

export function buildGpaPlanFileResumeDirective(doc: GpaPlanFileDocument): string {
  const pending = doc.tasks.filter((task) => !task.done);
  const lines = pending.map((task) => `- ${task.id}: ${task.title}`);
  return [
    `\nExisting project plan file: ${GPA_PLAN_RELATIVE_PATH} (status=${doc.status}).`,
    "Continue from this plan. Do not restart GOAL/PLAN analysis or recreate tasks already listed.",
    "Focus on incomplete tasks:",
    ...lines,
    "After finishing work, mark completed_task_ids for finished tasks. The runtime syncs progress back into the plan file."
  ].join("\n");
}
