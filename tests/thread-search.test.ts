import { describe, expect, it } from "vitest";
import { fuzzyMatchScore } from "../apps/desktop/src/main/storage";

describe("history conversation fuzzy search", () => {
  it("prefers contiguous title matches", () => {
    expect(fuzzyMatchScore("帮我搜索台风巴威信息", "台风巴威")).toBeGreaterThan(
      fuzzyMatchScore("台风路径和巴威的历史资料", "台风巴威")
    );
  });

  it("matches characters in order when they are not contiguous", () => {
    expect(fuzzyMatchScore("使用 Python 写一个扫雷游戏", "py扫雷")).toBeGreaterThan(0);
    expect(fuzzyMatchScore("使用 Python 写一个扫雷游戏", "雷py扫")).toBe(0);
  });
});
