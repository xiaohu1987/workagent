import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveHttpDownloadFileName,
  shouldDownloadHttpResponse
} from "../apps/desktop/src/main/http-download";
import { writeUniqueDownload } from "../apps/desktop/src/main/http-proxy";
import { resolveApiCardDownloadFileName, type ApiCardConfig } from "../apps/desktop/src/renderer/cards/api-card";

describe("HTTP file response handling", () => {
  it("downloads successful binary responses but keeps JSON and XML as text", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(shouldDownloadHttpResponse(200, { "content-type": "image/png" }, png)).toBe(true);
    expect(shouldDownloadHttpResponse(200, { "content-type": "application/octet-stream" }, png)).toBe(true);
    expect(shouldDownloadHttpResponse(200, { "content-type": "text/plain" }, png)).toBe(true);
    expect(shouldDownloadHttpResponse(200, { "content-type": "application/json" }, new TextEncoder().encode("{}"))).toBe(false);
    expect(shouldDownloadHttpResponse(403, { "content-type": "image/png" }, png)).toBe(false);
  });

  it("uses the requested file name and appends the MIME extension safely", () => {
    expect(resolveHttpDownloadFileName({
      preferredFileName: "../季度报表",
      headers: { "content-type": "application/pdf" },
      url: "https://api.example.com/export"
    })).toBe("季度报表.pdf");
    expect(resolveHttpDownloadFileName({
      headers: {
        "content-type": "image/png",
        "content-disposition": "attachment; filename*=UTF-8''%E5%9B%BE%E7%89%87.png"
      },
      url: "https://api.example.com/export"
    })).toBe("图片.png");
    expect(resolveHttpDownloadFileName({
      preferredFileName: "CON",
      headers: { "content-type": "application/octet-stream" },
      url: "https://api.example.com/export"
    })).toBe("_CON");
  });

  it("finds a download file name field in an API card", () => {
    const config: ApiCardConfig = {
      title: "导出",
      method: "GET",
      url: "https://api.example.com/export",
      fields: [{ name: "downloadFileName", label: "下载文件名", type: "text" }]
    };
    expect(resolveApiCardDownloadFileName(config, { downloadFileName: "图片1.png" })).toBe("图片1.png");
  });

  it("writes downloads directly into the supplied thread output directory", async () => {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-http-download-test-"));
    const threadOutputDir = path.join(testRoot, "outputs", "thread-1");
    try {
      const first = await writeUniqueDownload(threadOutputDir, "report.pdf", new Uint8Array([1, 2, 3]));
      const second = await writeUniqueDownload(threadOutputDir, "report.pdf", new Uint8Array([4, 5, 6]));

      expect(first).toBe(path.join(threadOutputDir, "report.pdf"));
      expect(second).toBe(path.join(threadOutputDir, "report (1).pdf"));
      expect(await fs.readFile(first)).toEqual(Buffer.from([1, 2, 3]));
      expect(await fs.readFile(second)).toEqual(Buffer.from([4, 5, 6]));
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });
});
