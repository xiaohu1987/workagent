import { describe, expect, it } from "vitest";
import { ToolRuntime } from "../packages/tool-runtime/src/index";
import { astDiffSources } from "../packages/tool-runtime/src/ast";

describe("code.ast_diff tool", () => {
  it("is registered as a direct low-risk tool", () => {
    const { direct } = new ToolRuntime().listToolSpecs();
    const tool = direct.find((entry) => entry.name === "code.ast_diff");
    expect(tool).toBeTruthy();
    expect(tool?.riskLevel).toBe("low");
  });

  it("summarizes entity changes across common languages", async () => {
    const cases = [
      {
        path: "a.ts",
        before: "function one() { return 1; }\n",
        after: "function one() { return 2; }\nfunction two() { return 3; }\n"
      },
      {
        path: "a.py",
        before: "def one():\n  return 1\n",
        after: "def one():\n  return 2\ndef two():\n  return 3\n"
      },
      {
        path: "a.go",
        before: "func One() int { return 1 }\n",
        after: "func One() int { return 2 }\nfunc Two() int { return 3 }\n"
      }
    ];

    for (const entry of cases) {
      const result = await astDiffSources(entry.before, entry.after, entry.path);
      expect(result.language).toBeTruthy();
      expect(result.entities.some((entity) => entity.change === "modified")).toBe(true);
      expect(result.entities.some((entity) => entity.change === "added")).toBe(true);
    }
  });
});
