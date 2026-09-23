import { describe, expect, it } from "vitest";

import { isUserOriginatedMediaPrompt, resolveVerbatimMediaPrompt } from "@agent-runtime";

describe("resolveVerbatimMediaPrompt", () => {
  it("sends the user's own words even when the model proposed a rewrite", () => {
    const original = "画一只橘猫坐在窗台上";
    const resolved = resolveVerbatimMediaPrompt({
      userInput: original,
      requestedPrompt: "A high-detail illustration of an orange tabby cat, cinematic lighting, 8k"
    });

    expect(resolved.prompt).toBe(original);
    expect(resolved.source).toBe("user");
  });

  it("does not trim, translate, or decorate the user's message", () => {
    const original = "  生成一张图：\n  一只猫\n\n  ——不要加任何风格说明  ";
    const resolved = resolveVerbatimMediaPrompt({ userInput: original, requestedPrompt: "a cat" });

    expect(resolved.prompt).toBe(original);
  });

  it("falls back to the model prompt for internal turns", () => {
    const resolved = resolveVerbatimMediaPrompt({
      userInput: "[internal:gpa_completion_audit] 继续完成审计",
      requestedPrompt: "  a detailed sunset over the sea  "
    });

    expect(resolved.prompt).toBe("a detailed sunset over the sea");
    expect(resolved.source).toBe("model");
  });

  it("falls back to the model prompt when the turn carries no user speech", () => {
    expect(resolveVerbatimMediaPrompt({ userInput: "   ", requestedPrompt: "a cat" })).toEqual({
      prompt: "a cat",
      source: "model"
    });
    expect(resolveVerbatimMediaPrompt({ userInput: "", requestedPrompt: undefined })).toEqual({
      prompt: "",
      source: "model"
    });
  });
});

describe("isUserOriginatedMediaPrompt", () => {
  it("accepts plain user messages and rejects internal turns", () => {
    expect(isUserOriginatedMediaPrompt("再换一张")).toBe(true);
    expect(isUserOriginatedMediaPrompt("  [internal:observer] summary")).toBe(false);
    expect(isUserOriginatedMediaPrompt("")).toBe(false);
  });
});
