import { describe, expect, it } from "vitest";
import type { MessageRecord } from "@shared-types";
import {
  composeShareText,
  composeTaskAnswerBody,
  countShareAnswers,
  extractAnswerText,
  formatShareText,
  stripMarkdown,
  summarizeShareText
} from "../apps/desktop/src/renderer/lib/share-text";
import {
  SHARE_TARGET_PROTOCOLS,
  getShareAppSearchPaths,
  parseRegistryValueOutput,
  planShareLaunch,
  resolveShareFormat
} from "../apps/desktop/src/main/share-targets";

function message(role: MessageRecord["role"], content: string, id = `${role}-${content.length}`): MessageRecord {
  return {
    id,
    threadId: "thread-1",
    turnRunId: null,
    role,
    content,
    metadataJson: null,
    createdAt: "2026-09-17T00:00:00.000Z"
  };
}

describe("share answer extraction", () => {
  it("keeps prose blocks and drops tool event blocks", () => {
    const content = [
      "先看一下仓库结构。",
      '<event type="tool_call" name="fs.read">{"path":"package.json"}</event>',
      "结论：项目基于 Electron 与 Vite。",
      '<event type="tool_result" name="fs.read">ok</event>',
      "建议优先补齐测试。"
    ].join("\n");

    const answer = extractAnswerText(content);
    expect(answer).toContain("先看一下仓库结构。");
    expect(answer).toContain("结论：项目基于 Electron 与 Vite。");
    expect(answer).toContain("建议优先补齐测试。");
    expect(answer).not.toContain("<event");
    expect(answer).not.toContain("tool_call");
  });

  it("returns the raw body when no event blocks are present", () => {
    expect(extractAnswerText("  普通回答  ")).toBe("普通回答");
    expect(extractAnswerText("")).toBe("");
  });
});

describe("share scope selection", () => {
  const messages = [
    message("user", "帮我看看这个 bug"),
    message("assistant", "第一轮分析：问题出在状态机。", "a1"),
    message("user", "继续"),
    message("assistant", "最终结论：把阈值改成 0.6 即可。", "a2")
  ];

  it("shares only the final answer by default", () => {
    const body = composeTaskAnswerBody(messages, "final");
    expect(body).toContain("最终结论");
    expect(body).not.toContain("第一轮分析");
  });

  it("shares every answer in transcript order when scope is all", () => {
    const body = composeTaskAnswerBody(messages, "all");
    expect(body.indexOf("第一轮分析")).toBeLessThan(body.indexOf("最终结论"));
  });

  it("ignores assistant messages without prose and empty threads", () => {
    const empty = [message("assistant", '<event type="tool_call" name="shell.exec">ls</event>', "a3")];
    expect(countShareAnswers(empty)).toBe(0);
    expect(composeTaskAnswerBody(empty, "final")).toBe("");
    expect(composeTaskAnswerBody([], "all")).toBe("");
  });
});

describe("share text formatting per target", () => {
  it("keeps markdown for DingTalk and strips it for WeChat", () => {
    const body = "# 结论\n\n**建议**: 使用 `apply_patch`。";
    expect(formatShareText(body, "dingtalk")).toBe(body);
    const wechat = formatShareText(body, "wechat");
    expect(wechat).not.toContain("#");
    expect(wechat).not.toContain("**");
    expect(wechat).not.toContain("`");
    expect(wechat).toContain("结论");
    expect(wechat).toContain("建议: 使用 apply_patch。");
    expect(resolveShareFormat("wechat")).toBe("text");
    expect(resolveShareFormat("dingtalk")).toBe("markdown");
  });

  it("renders links, lists, code fences and tables as readable plain text", () => {
    const source = [
      "- 第一项",
      "- 第二项",
      "",
      "[文档](https://example.com/doc)",
      "",
      "```bash",
      "pnpm test",
      "```",
      "",
      "| 名称 | 状态 |",
      "| --- | --- |",
      "| build | 通过 |"
    ].join("\n");
    const plain = stripMarkdown(source);
    expect(plain).toContain("· 第一项");
    expect(plain).toContain("文档 (https://example.com/doc)");
    expect(plain).toContain("pnpm test");
    // Fence markers and table separator rows disappear.
    expect(plain).not.toContain("```");
    expect(plain).not.toContain("---");
    expect(plain).toContain("名称  状态");
    expect(plain).toContain("build  通过");
  });

  it("composes end-to-end for a target", () => {
    const text = composeShareText({
      messages: [message("assistant", "## 结果\n\n已完成。", "a9")],
      scope: "final",
      target: "wechat"
    });
    expect(text).toBe("结果\n\n已完成。");
  });

  it("summarizes long text for the panel header", () => {
    expect(summarizeShareText("  a\n b  ")).toBe("a b");
    expect(summarizeShareText("x".repeat(100), 10)).toHaveLength(11);
  });
});

describe("share target launch planning", () => {
  it("parses named values and App Paths default values from reg output", () => {
    const named = [
      "",
      "HKEY_CURRENT_USER\\Software\\Tencent\\WeChat",
      "    InstallPath    REG_SZ    C:\\Program Files (x86)\\Tencent\\WeChat\\"
    ].join("\r\n");
    expect(parseRegistryValueOutput(named, "InstallPath")).toBe("C:\\Program Files (x86)\\Tencent\\WeChat\\");
    expect(parseRegistryValueOutput(named, "Missing")).toBeNull();

    const appPath = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\DingTalk.exe",
      "    (Default)    REG_SZ    C:\\Program Files (x86)\\DingDing\\DingTalk.exe"
    ].join("\r\n");
    expect(parseRegistryValueOutput(appPath, null)).toBe("C:\\Program Files (x86)\\DingDing\\DingTalk.exe");
  });

  it("prefers a registry install path, then a discovered path, then the protocol", () => {
    expect(planShareLaunch("wechat", { registryPath: "C:\\WeChat\\WeChat.exe" }))
      .toEqual({ method: "app-path", value: "C:\\WeChat\\WeChat.exe" });
    expect(planShareLaunch("wechat", { registryPath: null, existingPaths: ["C:\\Other\\Weixin.exe"] }))
      .toEqual({ method: "app-path", value: "C:\\Other\\Weixin.exe" });
    expect(planShareLaunch("dingtalk", {})).toEqual({ method: "protocol", value: SHARE_TARGET_PROTOCOLS.dingtalk });
  });

  it("normalizes directory style install paths", () => {
    expect(planShareLaunch("wechat", { registryPath: '"C:\\Tencent\\WeChat\\"' }))
      .toEqual({ method: "app-path", value: "C:\\Tencent\\WeChat" });
  });

  it("probes both the 3.x and 4.x WeChat executables", () => {
    const paths = getShareAppSearchPaths("wechat", { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PFX" });
    expect(paths).toContain("C:\\PFX\\Tencent\\WeChat\\WeChat.exe");
    expect(paths).toContain("C:\\PFX\\Tencent\\Weixin\\Weixin.exe");
    expect(paths.some((item) => item.includes("LOCALAPPDATA"))).toBe(false);

    const withLocal = getShareAppSearchPaths("wechat", { ProgramFiles: "C:\\PF", LOCALAPPDATA: "C:\\LA" });
    expect(withLocal.some((item) => item === "C:\\LA\\Tencent\\WeChat\\WeChat.exe")).toBe(true);
  });
});
