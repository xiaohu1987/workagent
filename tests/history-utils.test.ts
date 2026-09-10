import { describe, expect, it } from "vitest";
import { isHistoryProjectGroupCollapsed } from "../apps/desktop/src/renderer/history/history-utils";

describe("history project folders", () => {
  it("collapses project folders until they are explicitly expanded", () => {
    expect(isHistoryProjectGroupCollapsed(new Set(), "d:/workagent")).toBe(true);
    expect(isHistoryProjectGroupCollapsed(new Set(["d:/workagent"]), "d:/workagent")).toBe(false);
    expect(isHistoryProjectGroupCollapsed(new Set(), "__standalone__", false)).toBe(false);
  });
});
