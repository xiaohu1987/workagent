import { describe, expect, it } from "vitest";
import { GitService } from "../apps/desktop/src/main/git-service";

describe("GitService", () => {
  it("returns an unavailable snapshot when the task has no project folder", async () => {
    await expect(new GitService().snapshot(null)).resolves.toEqual({
      available: false,
      message: "当前任务未选择项目文件夹。",
      ahead: 0,
      behind: 0,
      canCreatePullRequest: false,
      files: []
    });
  });
});
