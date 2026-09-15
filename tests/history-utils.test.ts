import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HISTORY_DELETE_DRAG_THRESHOLD_PX,
  HISTORY_DELETE_PRESS_MS,
  expandRect,
  historyDeleteGhostCopy,
  isHistoryProjectGroupCollapsed,
  isPointInRect,
  resolveHistoryDeleteDragTarget,
  shouldIgnoreHistoryDeleteDragFrom,
  shouldShowHistoryPressCursor,
  shouldStartHistoryDeleteDrag
} from "../apps/desktop/src/renderer/history/history-utils";

const historySidebar = readFileSync(new URL("../apps/desktop/src/renderer/history/history-sidebar.tsx", import.meta.url), "utf8");
const historyStyles = readFileSync(new URL("../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8");

describe("history project folders", () => {
  it("collapses project folders until they are explicitly expanded", () => {
    expect(isHistoryProjectGroupCollapsed(new Set(), "d:/workagent")).toBe(true);
    expect(isHistoryProjectGroupCollapsed(new Set(["d:/workagent"]), "d:/workagent")).toBe(false);
    expect(isHistoryProjectGroupCollapsed(new Set(), "__standalone__", false)).toBe(false);
  });
});

describe("history delete drag targets", () => {
  it("drags a single thread unless it is part of a multi-selection", () => {
    expect(resolveHistoryDeleteDragTarget({
      source: "thread",
      threadId: "a",
      selectedThreadIds: [],
      deletableThreadIds: ["a", "b"]
    })).toEqual({ kind: "thread", threadId: "a" });

    expect(resolveHistoryDeleteDragTarget({
      source: "thread",
      threadId: "a",
      selectedThreadIds: ["a", "b"],
      deletableThreadIds: ["a", "b"]
    })).toEqual({ kind: "threads", threadIds: ["a", "b"] });
  });

  it("refuses running threads and folders that still contain them", () => {
    expect(resolveHistoryDeleteDragTarget({
      source: "thread",
      threadId: "running",
      selectedThreadIds: [],
      deletableThreadIds: ["a"]
    })).toBeNull();

    expect(resolveHistoryDeleteDragTarget({
      source: "folder",
      folderCwd: "D:/repo",
      folderThreadIds: ["a", "running"],
      selectedThreadIds: [],
      deletableThreadIds: ["a"]
    })).toBeNull();

    expect(resolveHistoryDeleteDragTarget({
      source: "folder",
      folderCwd: "D:/repo",
      folderThreadIds: ["a", "b"],
      selectedThreadIds: [],
      deletableThreadIds: ["a", "b"]
    })).toEqual({ kind: "folder", cwd: "D:/repo", threadIds: ["a", "b"] });
  });

  it("builds ghost copy for trash and detects drop heat", () => {
    expect(historyDeleteGhostCopy({ kind: "thread", threadId: "a" }, { threadTitle: "修内存" })).toEqual({
      label: "修内存",
      detail: "拖到垃圾桶删除"
    });
    expect(historyDeleteGhostCopy({ kind: "threads", threadIds: ["a", "b"] }, {})).toEqual({
      label: "2 个聊天记录",
      detail: "拖到垃圾桶删除"
    });
    expect(historyDeleteGhostCopy({ kind: "folder", cwd: "D:/repo", threadIds: ["a"] }, { folderName: "repo" })).toEqual({
      label: "repo",
      detail: "共 1 个聊天"
    });

    expect(shouldStartHistoryDeleteDrag(15)).toBe(false);
    expect(shouldStartHistoryDeleteDrag(HISTORY_DELETE_DRAG_THRESHOLD_PX)).toBe(true);
    expect(shouldShowHistoryPressCursor(HISTORY_DELETE_PRESS_MS - 1)).toBe(false);
    expect(shouldShowHistoryPressCursor(HISTORY_DELETE_PRESS_MS)).toBe(true);

    const trash = { left: 400, top: 200, right: 680, bottom: 460 };
    expect(isPointInRect(540, 330, trash)).toBe(true);
    expect(isPointInRect(10, 10, trash)).toBe(false);
    expect(isPointInRect(372, 330, expandRect(trash, 28))).toBe(true);
    expect(expandRect(null, 28)).toBeNull();
  });

  it("does not treat checkbox clicks as a delete drag", () => {
    expect(shouldIgnoreHistoryDeleteDragFrom(null)).toBe(false);
    expect(shouldIgnoreHistoryDeleteDragFrom({
      closest: (selector) => selector.includes(".history-item-select") ? {} : null
    })).toBe(true);
    expect(shouldIgnoreHistoryDeleteDragFrom({
      closest: () => null
    })).toBe(false);
    expect(historySidebar).toContain("onPointerDown={(event) => event.stopPropagation()}");
    expect(historySidebar).toContain("shouldIgnoreHistoryDeleteDragFrom(event.target)");
    expect(historySidebar).toContain("activateHistoryThread(thread)");
    expect(historySidebar).toContain("onActivate?.()");
  });
});

describe("history delete trash interaction", () => {
  it("moves batch select into the context menu and deletes by dragging into the trash", () => {
    expect(historySidebar).not.toContain("history-selection-toggle");
    expect(historySidebar).not.toMatch(/label:\s*"删除任务"/);
    expect(historySidebar).not.toMatch(/label:\s*"移除项目"/);
    expect(historySidebar).toContain('label: "批量选择"');
    expect(historySidebar).toContain("HistoryTrashOverlay");
    expect(historySidebar).toContain("is-history-trashing");
    expect(historyStyles).toContain(".history-trash-overlay");
    expect(historyStyles).toContain("@keyframes history-trash-swallow");
    expect(historyStyles).toContain("@keyframes history-trash-glow-in");
    expect(historyStyles).toContain("linear-gradient(to bottom, rgba(255, 92, 78, 0.7)");
    expect(historyStyles).not.toContain("border: 3px solid #e45344");
    expect(historyStyles).not.toMatch(/\.history-item\.is-draggable,\s*\n\.history-project-heading\.is-draggable \{\s*\n\s*cursor: grab;/);
    expect(historyStyles).toContain("body.is-history-pressing");
    expect(historySidebar).toContain("is-history-pressing");
  });
});
