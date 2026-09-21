import { describe, expect, it } from "vitest";
import { normalizeServerUrl } from "../apps/desktop/src/main/cloud-notes";

describe("normalizeServerUrl", () => {
  it("给裸地址补协议与默认端口 3003", () => {
    expect(normalizeServerUrl("192.168.1.10")).toBe("http://192.168.1.10:3003");
    expect(normalizeServerUrl("http://127.0.0.1")).toBe("http://127.0.0.1:3003");
  });

  it("保留用户显式填写的端口", () => {
    expect(normalizeServerUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeServerUrl("https://notes.example.com")).toBe("https://notes.example.com");
  });

  it("反向代理的路径前缀不能被丢弃", () => {
    expect(normalizeServerUrl("http://8.162.8.43/cloudnotes")).toBe("http://8.162.8.43/cloudnotes");
    expect(normalizeServerUrl("8.162.8.43/cloudnotes/")).toBe("http://8.162.8.43/cloudnotes");
    expect(normalizeServerUrl("http://8.162.8.43:3003/cloudnotes")).toBe("http://8.162.8.43:3003/cloudnotes");
    expect(normalizeServerUrl("https://notes.example.com/cloudnotes")).toBe("https://notes.example.com/cloudnotes");
  });

  it("去掉多余结尾斜杠且不改动根路径行为", () => {
    expect(normalizeServerUrl("http://127.0.0.1:3003///")).toBe("http://127.0.0.1:3003");
  });

  it("拒绝空地址与非法协议", () => {
    expect(() => normalizeServerUrl("   ")).toThrowError(/请填写云笔记服务器地址/);
    expect(() => normalizeServerUrl("ftp://127.0.0.1:3003")).toThrowError(/只支持 http 或 https/);
  });
});
