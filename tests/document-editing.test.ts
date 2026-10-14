import { describe, expect, it } from "vitest";
import {
  applyLineEnding,
  countDocumentLines,
  detectLineEnding,
  getDocumentIndentSize,
  getDocumentSelectionPosition,
  getDocumentTabTitle,
  indentDocumentSelection,
  insertDocumentIndent,
  isDocumentDirty,
  isDocumentEditable
} from "../apps/desktop/src/renderer/workspace/document-editing";

describe("查看文档：编辑与换行工具", () => {
  it("按读入时的换行风格回写，不把整文件换行改掉", () => {
    expect(detectLineEnding("a\r\nb")).toBe("crlf");
    expect(detectLineEnding("a\nb")).toBe("lf");
    expect(applyLineEnding("a\nb", "crlf")).toBe("a\r\nb");
    expect(applyLineEnding("a\r\nb", "lf")).toBe("a\nb");
    expect(applyLineEnding("a\r\nb\r\n", "crlf")).toBe("a\r\nb\r\n");
  });

  it("行数与 gutter 对齐：空文件也算一行", () => {
    expect(countDocumentLines("")).toBe(1);
    expect(countDocumentLines("a")).toBe(1);
    expect(countDocumentLines("a\nb")).toBe(2);
    expect(countDocumentLines("a\nb\n")).toBe(3);
  });

  it("脏标记只在内容与读入版本不同时为真", () => {
    expect(isDocumentDirty("a", "a")).toBe(false);
    expect(isDocumentDirty("a", "b")).toBe(true);
    expect(isDocumentDirty("a\n", "a\r\n")).toBe(true);
  });

  it("代码按 2 空格缩进，文档与文本按 4 空格", () => {
    expect(getDocumentIndentSize("code")).toBe(2);
    expect(getDocumentIndentSize("markdown")).toBe(4);
    expect(getDocumentIndentSize("html")).toBe(4);
    expect(getDocumentIndentSize("text")).toBe(4);
  });

  it("Tab 在单点或单行选区插入空格，在多行选区整块缩进", () => {
    expect(insertDocumentIndent("ab", 0, 0, 2)).toEqual({
      content: "  ab",
      selectionStart: 2,
      selectionEnd: 2
    });
    expect(insertDocumentIndent("abcdef", 1, 3, 2)).toEqual({
      content: "a  def",
      selectionStart: 3,
      selectionEnd: 3
    });
    expect(insertDocumentIndent("a\nb", 0, 3, 2)).toEqual({
      content: "  a\n  b",
      selectionStart: 2,
      selectionEnd: 7
    });
  });

  it("Shift+Tab 去掉缩进，最多吃掉一整格", () => {
    expect(indentDocumentSelection("  a\n  b", 0, 7, 2, true).content).toBe("a\nb");
    expect(indentDocumentSelection(" a", 0, 2, 2, true).content).toBe("a");
    expect(indentDocumentSelection("a", 0, 1, 2, true).content).toBe("a");
  });

  it("状态栏行列号按真实偏移换算并做边界收敛", () => {
    expect(getDocumentSelectionPosition("ab\ncd", 0)).toEqual({ line: 1, column: 1 });
    expect(getDocumentSelectionPosition("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
    expect(getDocumentSelectionPosition("ab", 99)).toEqual({ line: 1, column: 3 });
  });

  it("页签标题取文件名，二进制文件保持只读", () => {
    expect(getDocumentTabTitle("note.md")).toBe("note.md");
    expect(isDocumentEditable(false)).toBe(true);
    expect(isDocumentEditable(true)).toBe(false);
  });
});
