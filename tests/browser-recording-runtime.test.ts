import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserRecording, BrowserRecordingAction } from "@shared-types";
import {
  BrowserRecordingRuntime,
  buildRecordedLocatorCandidates,
  detectInstalledBrowsers,
  generateRecordingMarkdown,
  generatePlaywrightScript,
  isRecordedUrlPath
} from "../apps/desktop/src/main/browser-recording-runtime";

const temporaryDirectories: string[] = [];

async function createLayout() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-recordings-test-"));
  temporaryDirectories.push(root);
  return {
    root,
    recordingsDir: path.join(root, "recordings"),
    browserProfilesDir: path.join(root, "profiles")
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("browser recording runtime", () => {
  it("detects installed Chrome and Edge from Windows application paths", () => {
    const existing = new Set([
      "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ]);
    const detected = detectInstalledBrowsers("win32", {
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)"
    }, (candidate) => existing.has(candidate));

    expect(detected).toEqual([
      expect.objectContaining({ family: "chrome", available: true, executablePath: expect.stringContaining("chrome.exe") }),
      expect.objectContaining({ family: "edge", available: true, executablePath: expect.stringContaining("msedge.exe") })
    ]);
  });

  it("prefers a configured Chrome executable path over automatic detection", () => {
    const configured = "D:\\Portable\\Chrome\\chrome.exe";
    const detected = detectInstalledBrowsers("win32", {
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local"
    }, (candidate) => candidate === configured, configured);

    expect(detected.find((browser) => browser.family === "chrome")).toEqual({
      family: "chrome",
      label: "Google Chrome",
      available: true,
      executablePath: configured
    });
  });

  it("marks an invalid configured Chrome path unavailable instead of silently using another binary", () => {
    const detected = detectInstalledBrowsers("win32", {
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local"
    }, (candidate) => candidate.startsWith("C:"), "D:\\Missing\\chrome.exe");

    expect(detected.find((browser) => browser.family === "chrome")).toEqual(expect.objectContaining({
      family: "chrome",
      available: false,
      executablePath: null
    }));
  });

  it("rejects starting new recordings with Edge while keeping browser family support for legacy playback", async () => {
    const layout = await createLayout();
    const runtime = createRuntime(layout);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([{ family: "edge", label: "Microsoft Edge", available: true, executablePath: "C:\\Edge\\msedge.exe" }]);
    await expect(runtime.startRecording({ browser: "edge" })).rejects.toThrow("仅支持 Google Chrome");
  });

  it("orders semantic locator candidates before the CSS fallback and preserves frame targeting", () => {
    const candidates = buildRecordedLocatorCandidates({
      testId: "save-profile",
      role: "button",
      accessibleName: "保存",
      label: "保存资料",
      placeholder: "名称",
      name: "save",
      id: "save-button",
      text: "保存",
      css: "main > button:nth-of-type(2)"
    }, { name: "checkout", url: "https://example.test/frame" });

    expect(candidates.map((candidate) => candidate.strategy)).toEqual([
      "testId", "role", "label", "placeholder", "name", "id", "text", "css"
    ]);
    expect(candidates.every((candidate) => candidate.frame?.name === "checkout")).toBe(true);
  });

  it("generates syntactically valid Playwright TypeScript without embedding input values", () => {
    const recording = makeRecording("recording-1");
    const actions: BrowserRecordingAction[] = [
      { id: "a1", pageId: "page-1", type: "navigate", url: "https://example.test/login", createdAt: recording.createdAt },
      {
        id: "a2", pageId: "page-1", type: "fill",
        locator: { strategy: "label", value: "密码", exact: true }, valueKey: "password_1", createdAt: recording.createdAt
      },
      {
        id: "a3", pageId: "page-1", type: "click",
        locator: { strategy: "role", role: "button", value: "登录", exact: true },
        expectedUrl: "https://example.test/home", opensPageId: "page-2", createdAt: recording.createdAt
      },
      {
        id: "a4", pageId: "page-2", type: "upload",
        locator: { strategy: "css", value: "input[type=file]" }, fileKey: "avatar_2", createdAt: recording.createdAt
      }
    ];

    const script = generatePlaywrightScript(recording, actions);
    const transpiled = ts.transpileModule(script, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    });

    expect(transpiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([]);
    expect(script).toContain('config.inputs["password_1"]');
    expect(script).toContain('config.files["avatar_2"]');
    expect(script).toContain("waitForRecordedUrl");
    expect(script).toContain("timeout = 15_000");
    expect(script).not.toContain("plain-text-password");
  });

  it("generates a Chinese markdown document with a safe summary and script block", () => {
    const recording = { ...makeRecording("文档录制"), startUrl: "https://example.test/callback?code=one-time-token" };
    const actions: BrowserRecordingAction[] = [
      { id: "a1", pageId: "page-1", type: "navigate", url: recording.startUrl, createdAt: recording.createdAt },
      { id: "a2", pageId: "page-1", type: "fill", locator: { strategy: "label", value: "密码", exact: true }, valueKey: "password_1", createdAt: recording.createdAt },
      { id: "a3", pageId: "page-1", type: "upload", locator: { strategy: "css", value: "input[type=file]" }, fileKey: "file_1", createdAt: recording.createdAt }
    ];
    const markdown = generateRecordingMarkdown(recording, actions, "await page.goto('https://example.test');", {
      inputs: { password_1: "plain-text-password", start_date: "2026-08-31", category_1: "特殊立项" }, files: {}
    });
    expect(markdown).toContain("## 操作步骤");
    expect(markdown).toContain("填写文本字段label 定位");
    expect(markdown).toContain("配置项 password_1");
    expect(markdown).toContain("```ts");
    expect(markdown).not.toContain("one-time-token");
    expect(markdown).not.toContain("plain-text-password");
    expect(markdown).not.toContain("C:\\private\\secret.pdf");
  });

  it("includes ordinary text, select, and date values while hiding sensitive fields", () => {
    const recording = makeRecording("字段值");
    const actions: BrowserRecordingAction[] = [
      { id: "a1", pageId: "page-1", type: "fill", locator: { strategy: "label", value: "项目名称", exact: true }, valueKey: "project_name_1", createdAt: recording.createdAt },
      { id: "a2", pageId: "page-1", type: "select", locator: { strategy: "label", value: "项目类型", exact: true }, valueKey: "project_type_2", createdAt: recording.createdAt },
      { id: "a3", pageId: "page-1", type: "fill", locator: { strategy: "label", value: "开始日期", exact: true }, valueKey: "start_date_3", createdAt: recording.createdAt },
      { id: "a4", pageId: "page-1", type: "fill", locator: { strategy: "label", value: "密码", exact: true }, valueKey: "password_4", createdAt: recording.createdAt }
    ];
    const markdown = generateRecordingMarkdown(recording, actions, undefined, {
      inputs: { project_name_1: "测试项目", project_type_2: "特殊立项", start_date_3: "2026-08-31", password_4: "hidden-secret" }, files: {}
    });
    expect(markdown).toContain("填写文本字段label 定位“项目名称”：“测试项目”");
    expect(markdown).toContain("在下拉字段label 定位“项目类型”中选择：“特殊立项”");
    expect(markdown).toContain("填写日期字段label 定位“开始日期”：“2026-08-31”");
    expect(markdown).toContain("值已隐藏");
    expect(markdown).not.toContain("hidden-secret");
  });

  it("explains a menu trigger and the following menu selection as one contextual flow", () => {
    const recording = makeRecording("菜单录制");
    const markdown = generateRecordingMarkdown(recording, [
      { id: "a1", pageId: "page-1", type: "click", locator: { strategy: "role", role: "button", value: "+ 立项", exact: true }, createdAt: recording.createdAt },
      { id: "a2", pageId: "page-1", type: "click", locator: { strategy: "role", role: "menuitem", value: "特殊立项", exact: true }, createdAt: recording.createdAt }
    ]);
    expect(markdown).toContain("点击角色 button“+ 立项”，打开菜单或下拉选项");
    expect(markdown).toContain("在上一步打开的菜单或下拉框中选择角色 menuitem“特殊立项”");
  });

  it("matches SSO callback URLs by origin and path instead of one-time tokens", () => {
    expect(isRecordedUrlPath(
      "http://10.136.0.123:40002/ProjectManage/Oidc#id_token=new-token&state=new-state",
      "http://10.136.0.123:40002/ProjectManage/Oidc#id_token=old-token&state=old-state"
    )).toBe(true);
    expect(isRecordedUrlPath(
      "http://10.136.0.123:40002/ProjectManage/startProAddList",
      "http://10.136.0.123:40002/ProjectManage/startProEdit"
    )).toBe(false);
  });

  it("recovers a checkpointed recording as interrupted and keeps secrets out of the generated script", async () => {
    const layout = await createLayout();
    const recording = makeRecording("recover-me", path.join(layout.recordingsDir, "recover-me"), "recording");
    const actions: BrowserRecordingAction[] = [
      { id: "a1", pageId: "page-1", type: "navigate", url: "https://example.test", createdAt: recording.createdAt },
      {
        id: "a2", pageId: "page-1", type: "fill",
        locator: { strategy: "name", value: "password" }, valueKey: "password_1", createdAt: recording.createdAt
      }
    ];
    await fs.mkdir(recording.directory, { recursive: true });
    await Promise.all([
      writeJson(path.join(recording.directory, "metadata.json"), recording),
      writeJson(path.join(recording.directory, "actions.json"), actions),
      writeJson(path.join(recording.directory, "recording.config.json"), {
        browser: "chrome",
        executablePath: "C:\\Chrome\\chrome.exe",
        userDataDir: layout.browserProfilesDir,
        inputs: { password_1: "plain-text-password" },
        files: { upload_1: ["C:\\private\\secret.pdf"] }
      })
    ]);
    const runtime = createRuntime(layout);

    await runtime.initialize();

    const recovered = (await runtime.listRecordings())[0]!;
    const script = await runtime.readScript(recording.id);
    expect(recovered.status).toBe("interrupted");
    expect(recovered.stepCount).toBe(2);
    expect(script).toContain("password_1");
    expect(script).not.toContain("plain-text-password");
    expect(script).not.toContain("secret.pdf");
    const document = await runtime.readDocument(recording.id);
    expect(document).toContain("## 操作步骤");
    expect(document).toContain("```ts");
    expect(document).not.toContain("plain-text-password");
    expect(document).not.toContain("secret.pdf");
  });

  it("marks a checkpoint with a missing config invalid instead of failing initialization", async () => {
    const layout = await createLayout();
    const recording = makeRecording("broken", path.join(layout.recordingsDir, "broken"), "recording");
    await fs.mkdir(recording.directory, { recursive: true });
    await writeJson(path.join(recording.directory, "metadata.json"), recording);
    await writeJson(path.join(recording.directory, "actions.json"), [
      { id: "a1", pageId: "page-1", type: "navigate", url: "https://example.test", createdAt: recording.createdAt }
    ]);
    const runtime = createRuntime(layout);

    await expect(runtime.initialize()).resolves.toBeUndefined();
    expect((await runtime.listRecordings())[0]).toEqual(expect.objectContaining({ status: "invalid", lastError: "录制配置文件缺失或损坏。" }));
  });

  it("renames bundles and delegates deletion to the recoverable trash operation", async () => {
    const layout = await createLayout();
    const recording = makeRecording("managed", path.join(layout.recordingsDir, "managed"), "ready");
    await fs.mkdir(recording.directory, { recursive: true });
    await Promise.all([
      writeJson(path.join(recording.directory, "metadata.json"), recording),
      writeJson(path.join(recording.directory, "actions.json"), []),
      writeJson(path.join(recording.directory, "recording.config.json"), {
        browser: "chrome", executablePath: "chrome.exe", userDataDir: layout.browserProfilesDir, inputs: {}, files: {}
      }),
      fs.writeFile(path.join(recording.directory, "recording.ts"), "// original\n", "utf8")
    ]);
    const trashed: string[] = [];
    const runtime = createRuntime(layout, async (directory) => { trashed.push(directory); });
    await runtime.initialize();
    expect(await fs.readFile(path.join(recording.directory, "recording.md"), "utf8")).toContain("# 登录流程");

    const renamed = await runtime.rename(recording.id, "更新资料");
    await runtime.delete(recording.id);

    expect(renamed.name).toBe("更新资料");
    expect(trashed).toEqual([recording.directory]);
  });

  it("merges input events and associates navigation and a popup with the preceding click", async () => {
    const layout = await createLayout();
    const primary = createFakePage();
    const popup = createFakePage({ opener: primary.page, url: "https://example.test/popup" });
    const context = createFakeContext(primary, popup);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const runtime = createRuntime(layout);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    await runtime.startRecording({ browser: "chrome" });
    const target = { label: "账号", css: "input[name=account]" };
    await context.binding!({ page: primary.page, frame: primary.page }, { kind: "fill", target, value: "a" });
    await context.binding!({ page: primary.page, frame: primary.page }, { kind: "fill", target, value: "alice" });
    await context.binding!({ page: primary.page, frame: primary.page }, { kind: "click", target: { role: "button", accessibleName: "继续", css: "button" } });
    primary.setUrl("https://example.test/next");
    primary.emit("framenavigated", primary.page);
    context.emit("page", popup.page);
    await vi.waitFor(async () => {
      const actions = await readJson<BrowserRecordingAction[]>(path.join(layout.recordingsDir, runtime.getState().recordingId!, "actions.json"));
      expect(actions.at(-1)).toEqual(expect.objectContaining({ type: "click", expectedUrl: "https://example.test/next", opensPageId: "page-2" }));
    });

    const stopped = await runtime.stopRecording();
    const directory = path.join(layout.recordingsDir, stopped.recordingId!);
    const actions = await readJson<BrowserRecordingAction[]>(path.join(directory, "actions.json"));
    const config = await readJson<{ inputs: Record<string, string> }>(path.join(directory, "recording.config.json"));
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual(expect.objectContaining({ type: "fill" }));
    expect(Object.values(config.inputs)).toEqual(["alice"]);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("opens and records multiple configured start URLs", async () => {
    const layout = await createLayout();
    const first = createFakePage();
    const second = createFakePage();
    const context = createFakeContext(first, second);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const runtime = createRuntime(layout);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    const started = await runtime.startRecording({ browser: "chrome", startUrls: ["https://example.test/one", "example.test/two"] });
    const directory = path.join(layout.recordingsDir, started.recordingId!);
    const actions = await readJson<BrowserRecordingAction[]>(path.join(directory, "actions.json"));
    const metadata = await readJson<BrowserRecording>(path.join(directory, "metadata.json"));

    expect(actions.filter((action) => action.type === "navigate").map((action) => action.url)).toEqual([
      "https://example.test/one",
      "https://example.test/two"
    ]);
    expect(metadata.startUrls).toEqual(["https://example.test/one", "https://example.test/two"]);
    await runtime.cancelRecording();
  });

  it("cancels a recording and removes its checkpoint directory", async () => {
    const layout = await createLayout();
    const context = createFakeContext(createFakePage());
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const runtime = createRuntime(layout);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    const started = await runtime.startRecording({ browser: "chrome" });
    const directory = path.join(layout.recordingsDir, started.recordingId!);
    await expect(fs.access(directory)).resolves.toBeUndefined();

    await expect(runtime.cancelRecording()).resolves.toEqual(expect.objectContaining({ mode: "idle" }));
    await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays structured actions and records a successful run", async () => {
    const layout = await createLayout();
    const recording = await writeReadyRecording(layout, [
      { id: "a1", pageId: "page-1", type: "navigate", url: "https://example.test/home", createdAt: "2026-08-28T08:00:00.000Z" }
    ]);
    const page = createFakePage();
    const context = createFakeContext(page);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const runtime = createRuntime(layout);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    await runtime.play(recording.id);
    await vi.waitFor(() => expect(runtime.getState().mode).toBe("completed"));

    expect(page.goto).toHaveBeenCalledWith("https://example.test/home", { waitUntil: "domcontentloaded" });
    expect((await runtime.listRecordings())[0]).toEqual(expect.objectContaining({ lastRunStatus: "passed", lastError: null }));
  });

  it("seeds the replay page with the recording start URL when the first step is an interaction", async () => {
    const layout = await createLayout();
    const recording = await writeReadyRecording(layout, [
      { id: "a1", pageId: "page-1", type: "click", locator: { strategy: "css", value: "#open" }, createdAt: "2026-08-28T08:00:00.000Z" }
    ]);
    const page = createFakePage();
    const context = createFakeContext(page);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const runtime = createRuntime(layout);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    await runtime.play(recording.id);
    await vi.waitFor(() => expect(runtime.getState().mode).toBe("completed"));
    expect(page.goto).toHaveBeenCalledWith(recording.startUrl, { waitUntil: "domcontentloaded" });
  });

  it("does not replay stale SSO redirect navigations after the initial page", async () => {
    const layout = await createLayout();
    const recording = await writeReadyRecording(layout, [
      { id: "a1", pageId: "page-1", type: "navigate", url: "http://10.136.0.123:40002/ProjectManage/startProAddList", createdAt: "2026-08-28T08:00:00.000Z" },
      { id: "a2", pageId: "page-1", type: "navigate", url: "https://ipsademo.isoftstone.com/passport/?returnUrl=old-state", createdAt: "2026-08-28T08:00:01.000Z" }
    ]);
    const page = createFakePage();
    const context = createFakeContext(page);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const runtime = createRuntime(layout);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    await runtime.play(recording.id);
    await vi.waitFor(() => expect(runtime.getState().mode).toBe("completed"));
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith("http://10.136.0.123:40002/ProjectManage/startProAddList", { waitUntil: "domcontentloaded" });
  });

  it("creates a new replay page for a secondary initial navigation", async () => {
    const layout = await createLayout();
    const recording = await writeReadyRecording(layout, [
      { id: "a1", pageId: "page-1", type: "navigate", url: "https://example.test/one", createdAt: "2026-08-28T08:00:00.000Z" },
      { id: "a2", pageId: "page-2", type: "navigate", url: "https://example.test/two", createdAt: "2026-08-28T08:00:01.000Z" }
    ]);
    const first = createFakePage();
    const second = createFakePage();
    const context = createFakeContext(first, second);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const runtime = createRuntime(layout);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    await runtime.play(recording.id);
    await vi.waitFor(() => expect(runtime.getState().mode).toBe("completed"));
    expect(first.goto).toHaveBeenCalledWith("https://example.test/one", { waitUntil: "domcontentloaded" });
    expect(second.goto).toHaveBeenCalledWith("https://example.test/two", { waitUntil: "domcontentloaded" });
  });

  it("pauses on failure, redacts configured values, and retries the same step", async () => {
    const layout = await createLayout();
    const secret = "plain-text-password";
    const recording = await writeReadyRecording(layout, [
      {
        id: "a1", pageId: "page-1", type: "fill", locator: { strategy: "label", value: "密码" },
        valueKey: "password_1", createdAt: "2026-08-28T08:00:00.000Z"
      }
    ], { inputs: { password_1: secret } });
    const fill = vi.fn().mockRejectedValueOnce(new Error(`无法填写 ${secret}`)).mockResolvedValueOnce(undefined);
    const page = createFakePage({ locator: { fill } });
    const context = createFakeContext(page);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const runtime = createRuntime(layout);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    await runtime.play(recording.id);
    await vi.waitFor(() => expect(runtime.getState().mode).toBe("paused"));
    expect(runtime.getState().error).toContain("[redacted]");
    expect(runtime.getState().error).not.toContain(secret);

    await runtime.retryPlayback();
    await vi.waitFor(() => expect(runtime.getState().mode).toBe("completed"));
    expect(fill).toHaveBeenCalledTimes(2);
    expect((await runtime.listRecordings())[0]?.lastRunStatus).toBe("passed");
  });

  it("announces LLM repair before requesting the structured candidate", async () => {
    const layout = await createLayout();
    const recording = await writeReadyRecording(layout, [
      { id: "a1", pageId: "page-1", type: "click", locator: { strategy: "role", role: "menuitem", value: "特殊立项", exact: true }, createdAt: "now" }
    ]);
    const page = createFakePage({ locator: { click: vi.fn().mockRejectedValue(new Error("target hidden")) } });
    const context = createFakeContext(page);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const order: string[] = [];
    const chatBridge = {
      begin: vi.fn(async () => ({ threadId: "thread-1", recordingId: recording.id, runId: "run-1", turnRunId: null, model: null, provider: null, closed: false })),
      progress: vi.fn(async (handle: unknown, message: string) => { if (message.includes("LLM 正在分析")) order.push("progress"); }),
      narrate: vi.fn(async () => { order.push("narrate"); }),
      requestRepairCandidate: vi.fn(async () => { order.push("candidate"); return null; }),
      complete: vi.fn(async () => undefined)
    };
    const runtime = createRuntime(layout, vi.fn(async () => undefined), async () => [], chatBridge);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    await runtime.play(recording.id, "thread-1");
    await vi.waitFor(() => expect(runtime.getState().mode).toBe("paused"));
    await vi.waitFor(() => expect(order).toContain("candidate"));
    expect(order.indexOf("narrate")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("narrate")).toBeLessThan(order.indexOf("candidate"));
  });

  it("automatically applies one valid LLM repair and resumes from the failed step", async () => {
    const layout = await createLayout();
    const recording = await writeReadyRecording(layout, [
      { id: "a1", pageId: "page-1", type: "click", locator: { strategy: "role", role: "button", value: "保存", exact: true }, createdAt: "now" }
    ]);
    const click = vi.fn().mockRejectedValueOnce(new Error("target hidden")).mockResolvedValue(undefined);
    const page = createFakePage({ locator: { click } });
    const context = createFakeContext(page);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const candidate = {
      id: "candidate-auto", recordingId: recording.id, threadId: "thread-1", baseRevision: recording.updatedAt,
      operations: [{ op: "replace" as const, actionId: "a1", action: { id: "a1", pageId: "page-1", type: "click" as const, locator: { strategy: "css" as const, value: "button.save" }, createdAt: "now" } }],
      rationale: ["改用稳定 CSS 定位"], confidence: 0.9, createdAt: "now", source: "replay-failure" as const, failedActionId: "a1"
    };
    const chatBridge = {
      begin: vi.fn(async () => ({ threadId: "thread-1", recordingId: recording.id, runId: "run-1", turnRunId: null, model: null, provider: null, closed: false })),
      progress: vi.fn(async () => undefined), narrate: vi.fn(async () => undefined),
      requestRepairCandidate: vi.fn(async () => candidate), complete: vi.fn(async () => undefined)
    };
    const runtime = createRuntime(layout, vi.fn(async () => undefined), async () => [], chatBridge);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    await runtime.play(recording.id, "thread-1");
    await vi.waitFor(() => expect(runtime.getState().mode).toBe("completed"));
    expect(click).toHaveBeenCalledTimes(2);
    expect(context.context.newPage).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(recording.directory, "enhanced-actions.json"), "utf8")).toContain("button.save");
    const llmFiles = await fs.readdir(path.join(recording.directory, "llm"));
    expect(llmFiles.some((file) => file.startsWith("applied-") && file.endsWith(".json"))).toBe(true);
  });

  it("prefers a visible locator when a linked field has hidden and visible duplicates", async () => {
    const layout = await createLayout();
    const recording = await writeReadyRecording(layout, [
      { id: "a1", pageId: "page-1", type: "click", locator: { strategy: "role", role: "button", value: "联动字段", exact: true }, createdAt: "now" }
    ]);
    const clickVisible = vi.fn(async () => undefined);
    const hidden = { isVisible: vi.fn(async () => false) };
    const visible = { isVisible: vi.fn(async () => true), click: clickVisible };
    const duplicateLocator = {
      count: vi.fn(async () => 2),
      nth: vi.fn((index: number) => index === 0 ? hidden : visible)
    };
    const page = createFakePage({ locator: duplicateLocator });
    const context = createFakeContext(page);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const runtime = createRuntime(layout);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    await runtime.play(recording.id);
    await vi.waitFor(() => expect(runtime.getState().mode).toBe("completed"));
    expect(clickVisible).toHaveBeenCalledTimes(1);
  });

  it("asks for a replacement when an uploaded file is missing and updates only the config", async () => {
    const layout = await createLayout();
    const replacement = path.join(layout.root, "replacement.txt");
    await fs.writeFile(replacement, "replacement", "utf8");
    const recording = await writeReadyRecording(layout, [
      {
        id: "a1", pageId: "page-1", type: "upload", locator: { strategy: "css", value: "input[type=file]" },
        fileKey: "upload_1", createdAt: "2026-08-28T08:00:00.000Z"
      }
    ], { files: { upload_1: [path.join(layout.root, "missing.txt")] } });
    const setInputFiles = vi.fn(async () => undefined);
    const page = createFakePage({ locator: { setInputFiles } });
    const context = createFakeContext(page);
    vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context.context as never);
    const runtime = createRuntime(layout, vi.fn(async () => undefined), async () => [replacement]);
    vi.spyOn(runtime, "detectBrowsers").mockReturnValue([detectedChrome()]);

    await runtime.play(recording.id);
    await vi.waitFor(() => expect(runtime.getState()).toEqual(expect.objectContaining({ mode: "paused", missingFileKey: "upload_1" })));
    await runtime.retryPlayback();
    await vi.waitFor(() => expect(runtime.getState().mode).toBe("completed"));

    expect(setInputFiles).toHaveBeenCalledWith([replacement], { timeout: 15_000 });
    const config = await readJson<{ files: Record<string, string[]> }>(path.join(recording.directory, "recording.config.json"));
    expect(config.files.upload_1).toEqual([replacement]);
    expect(await fs.readFile(path.join(recording.directory, "recording.ts"), "utf8")).not.toContain(replacement);
  });
});

function createRuntime(
  layout: { recordingsDir: string; browserProfilesDir: string },
  trashDirectory: (directory: string) => Promise<void> = vi.fn(async () => undefined),
  chooseFiles: (input: { multiple: boolean; title: string }) => Promise<string[]> = async () => [],
  chatBridge?: unknown
) {
  return new BrowserRecordingRuntime({
    ...layout,
    chooseFiles,
    trashDirectory,
    chatBridge: chatBridge as never
  });
}

function detectedChrome() {
  return { family: "chrome" as const, label: "Google Chrome", available: true, executablePath: "C:\\Chrome\\chrome.exe" };
}

function createFakePage(options: { opener?: unknown; url?: string; locator?: Record<string, unknown> } = {}) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let currentUrl = options.url ?? "about:blank";
  const locator: Record<string, any> = {
    count: vi.fn(async () => 1),
    fill: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => undefined),
    check: vi.fn(async () => undefined),
    uncheck: vi.fn(async () => undefined),
    setInputFiles: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    nth: vi.fn(() => locator),
    ...options.locator
  };
  const page: Record<string, any> = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    opener: vi.fn(async () => options.opener ?? null),
    mainFrame: vi.fn(() => page),
    parentFrame: vi.fn(() => null),
    frames: vi.fn(() => [page]),
    name: vi.fn(() => ""),
    url: vi.fn(() => currentUrl),
    goto: vi.fn(async (url: string) => { currentUrl = url; }),
    close: vi.fn(async () => undefined),
    isClosed: vi.fn(() => false),
    evaluate: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => undefined),
    keyboard: { press: vi.fn(async () => undefined) },
    locator: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByPlaceholder: vi.fn(() => locator),
    getByText: vi.fn(() => locator)
  };
  return {
    page,
    goto: page.goto,
    setUrl: (url: string) => { currentUrl = url; },
    emit: (event: string, ...args: unknown[]) => { for (const listener of listeners.get(event) ?? []) listener(...args); }
  };
}

function createFakeContext(...fakePages: ReturnType<typeof createFakePage>[]) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let binding: ((source: { page: any; frame: any }, payload: any) => Promise<void>) | null = null;
  let pageIndex = 0;
  const close = vi.fn(async () => {
    for (const listener of listeners.get("close") ?? []) listener();
  });
  const context = {
    exposeBinding: vi.fn(async (_name: string, handler: typeof binding) => { binding = handler; }),
    addInitScript: vi.fn(async () => undefined),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    newPage: vi.fn(async () => fakePages[Math.min(pageIndex++, fakePages.length - 1)]!.page),
    pages: vi.fn(() => fakePages.slice(0, Math.max(1, pageIndex)).map((item) => item.page)),
    waitForEvent: vi.fn(async () => fakePages.at(-1)!.page),
    close
  };
  return {
    context,
    close,
    get binding() { return binding; },
    emit: (event: string, ...args: unknown[]) => { for (const listener of listeners.get(event) ?? []) listener(...args); }
  };
}

async function writeReadyRecording(
  layout: { recordingsDir: string; browserProfilesDir: string },
  actions: BrowserRecordingAction[],
  configOverrides: { inputs?: Record<string, string>; files?: Record<string, string[]> } = {}
) {
  const recording = makeRecording("playback", path.join(layout.recordingsDir, "playback"), "ready");
  await fs.mkdir(path.join(recording.directory, "runs"), { recursive: true });
  await Promise.all([
    writeJson(path.join(recording.directory, "metadata.json"), { ...recording, stepCount: actions.length }),
    writeJson(path.join(recording.directory, "actions.json"), actions),
    writeJson(path.join(recording.directory, "recording.config.json"), {
      browser: "chrome", executablePath: "C:\\Chrome\\chrome.exe", userDataDir: layout.browserProfilesDir,
      inputs: configOverrides.inputs ?? {}, files: configOverrides.files ?? {}
    }),
    fs.writeFile(path.join(recording.directory, "recording.ts"), generatePlaywrightScript(recording, actions), "utf8")
  ]);
  return recording;
}

function makeRecording(
  id: string,
  directory = `C:\\recordings\\${id}`,
  status: BrowserRecording["status"] = "ready"
): BrowserRecording {
  const timestamp = "2026-08-28T08:00:00.000Z";
  return {
    id,
    name: "登录流程",
    browser: "chrome",
    startUrl: "https://example.test",
    status,
    stepCount: 0,
    directory,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null
  };
}

function writeJson(filePath: string, value: unknown): Promise<void> {
  return fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}
