import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "@shared-types";
import { MultimediaCanvasWorkspace } from "../apps/desktop/src/renderer/workspace/multimedia-canvas-workspace";
import { MultimediaCanvasSettingsPanel } from "../apps/desktop/src/renderer/workspace/multimedia-canvas-settings-panel";
import {
  countCanvasPromptCharacters,
  createCanvasSettings,
  normalizeCanvasCount,
  resolveCanvasImageModels,
  resolveCanvasModelValue,
  resolveCanvasOutputSize
} from "../apps/desktop/src/renderer/workspace/multimedia-canvas-settings";

const readText = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const app = readText("../apps/desktop/src/renderer/App.tsx");
const sidebar = readText("../apps/desktop/src/renderer/history/history-sidebar.tsx");
const canvasStyles = readText("../apps/desktop/src/renderer/workspace/multimedia-canvas.css");
const canvasSettingsSource = readText(
  "../apps/desktop/src/renderer/workspace/multimedia-canvas-settings.ts"
);

const CANVAS_ENTRY_MARKUP =
  '<span className="sidebar-nav-icon"><IconImage /></span><span>多媒体画布</span>';

/** 多模态图片模型配置：默认模型放在非首位，用来验证默认项优先而不是配置顺序。 */
const canvasConfig = {
  providers: [
    { id: "openai", name: "OpenAI", apiKey: "sk-live" },
    { id: "local", name: "本地网关" }
  ],
  models: [
    { id: "gpt-image-1", providerId: "openai", displayName: "GPT Image 1", role: "image" },
    { id: "flux-pro", providerId: "local", displayName: "FLUX Pro", role: "image" },
    { id: "gpt-5", providerId: "openai", displayName: "GPT-5", role: "reasoning" }
  ],
  multimodal: {
    image: { enabled: true, defaultProviderId: "local", defaultModelId: "flux-pro" }
  }
} as unknown as AppConfig;

describe("multimedia canvas view switching", () => {
  it("renders the canvas as hidden until it is the active workspace view", () => {
    const inactive = renderToStaticMarkup(createElement(MultimediaCanvasWorkspace, { active: false }));
    expect(inactive).toContain('<section class="multimedia-canvas" aria-label="多媒体画布" aria-hidden="true">');
    expect(inactive).not.toContain("is-active");

    const active = renderToStaticMarkup(createElement(MultimediaCanvasWorkspace, { active: true }));
    expect(active).toContain('<section class="multimedia-canvas is-active" aria-label="多媒体画布">');
  });

  it("survives ten consecutive switches without throwing or losing the active state", () => {
    const rendered: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const active = index % 2 === 0;
      rendered.push(renderToStaticMarkup(createElement(MultimediaCanvasWorkspace, { active })));
    }
    expect(rendered).toHaveLength(10);
    rendered.forEach((markup, index) => {
      const active = index % 2 === 0;
      expect(markup).toContain(`class="multimedia-canvas${active ? " is-active" : ""}"`);
      expect(markup).toContain("多媒体画布");
    });
  });

  it("keeps the canvas mounted for the whole session so a switch cannot reset it", () => {
    // A conditional mount would unmount the canvas on every switch and drop its
    // parameters and creation records; the canvas is therefore always rendered and
    // only its active flag changes.
    expect(app).toContain("<MultimediaCanvasWorkspace active={isCanvasOpen} config={config} />");
    expect(app).not.toContain("{isCanvasOpen ? <MultimediaCanvasWorkspace");
    expect(app).toContain("const [isCanvasOpen, setIsCanvasOpen] = useState(false);");
  });

  it("lets the sidebar entry open the canvas and marks it selected", () => {
    expect(app).toContain("canvasActive={isCanvasOpen}");
    expect(app).toContain("onOpenCanvas={() => setIsCanvasOpen(true)}");
    expect(sidebar).toContain("canvasActive: boolean;");
    expect(sidebar).toContain("aria-current={canvasActive ? \"page\" : undefined}");
    expect(sidebar).toContain(CANVAS_ENTRY_MARKUP);
    expect(sidebar).toContain("sidebar-nav-active-dot");
    // The entry is a first-level navigation item placed after 「新建项目」.
    expect(sidebar.indexOf(CANVAS_ENTRY_MARKUP)).toBeGreaterThan(sidebar.indexOf("<span>新建项目</span>"));
  });

  it("returns to the previous view when a task is opened or created", () => {
    expect(app).toContain("function activateNewThread(thread: ThreadRecord) {\n    setIsCanvasOpen(false);");
    expect(app).toContain("async function openThread(threadId: string, options?: { scrollToLatest?: boolean }) {\n    setIsCanvasOpen(false);");
  });

  it("hands the workspace row to the active canvas and keeps it hidden otherwise", () => {
    expect(canvasStyles).toContain(".multimedia-canvas {\n  display: none;");
    expect(canvasStyles).toContain(".multimedia-canvas.is-active {\n  display: flex;");
    expect(canvasStyles).toContain(".workspace:has(> .multimedia-canvas.is-active) > *:not(.multimedia-canvas) {");
  });
});

describe("multimedia canvas creation settings", () => {
  it("derives the model list from the multimodal image model config instead of a hardcoded list", () => {
    const models = resolveCanvasImageModels(canvasConfig);
    // Only role === "image" models are offered, and the configured default comes first.
    expect(models.map((model) => model.value)).toEqual(["local::flux-pro", "openai::gpt-image-1"]);
    expect(models.map((model) => model.label)).toEqual(["FLUX Pro · 本地网关", "GPT Image 1 · OpenAI"]);
    expect(models[0].isDefault).toBe(true);
    expect(models[1].isDefault).toBe(false);
    // Key readiness is reported per provider without exposing the key itself.
    expect(models.map((model) => model.hasApiKey)).toEqual([false, true]);
    // The option only carries key readiness, never the key material itself.
    expect(models.some((model) => "apiKey" in model || "apiKeyEnv" in model)).toBe(false);

    expect(canvasSettingsSource).toContain('model.role === "image"');
    expect(canvasSettingsSource).not.toContain("gpt-image");
    expect(canvasSettingsSource).not.toContain("flux");
  });

  it("offers nothing when no image model is configured", () => {
    expect(resolveCanvasImageModels(null)).toEqual([]);
    expect(
      resolveCanvasImageModels({ providers: [], models: [], multimodal: {} } as unknown as AppConfig)
    ).toEqual([]);
  });

  it("selects the multimodal default model once the config arrives", () => {
    const models = resolveCanvasImageModels(canvasConfig);
    expect(resolveCanvasModelValue(models, "")).toBe("local::flux-pro");
    // A stale or removed selection falls back to the default instead of breaking.
    expect(resolveCanvasModelValue(models, "openai::removed")).toBe("local::flux-pro");
    // An explicit valid choice is preserved.
    expect(resolveCanvasModelValue(models, "openai::gpt-image-1")).toBe("openai::gpt-image-1");
    expect(createCanvasSettings(canvasConfig).modelValue).toBe("local::flux-pro");
  });

  it("keeps the output size in sync with resolution, aspect ratio and count", () => {
    const base = { resolutionId: "1k", aspectRatioId: "1:1", count: 1 };
    expect(resolveCanvasOutputSize(base).label).toBe("1024 × 1024 · 1 张");

    // Resolution drives the long edge.
    expect(resolveCanvasOutputSize({ ...base, resolutionId: "2k" }).width).toBe(2048);
    // Aspect ratio drives the short edge and stays a multiple of 8.
    expect(resolveCanvasOutputSize({ ...base, aspectRatioId: "16:9" })).toMatchObject({
      width: 1024,
      height: 576
    });
    expect(resolveCanvasOutputSize({ ...base, aspectRatioId: "9:16" })).toMatchObject({
      width: 576,
      height: 1024
    });
    // Count only changes the rendered summary.
    expect(resolveCanvasOutputSize({ ...base, count: 4 }).label).toBe("1024 × 1024 · 4 张");
    expect(resolveCanvasOutputSize({ ...base, resolutionId: "4k", aspectRatioId: "4:3" })).toMatchObject({
      width: 4096,
      height: 3072
    });
  });

  it("counts prompt characters and clamps the requested count", () => {
    expect(countCanvasPromptCharacters("")).toBe(0);
    expect(countCanvasPromptCharacters("雨后夜景")).toBe(4);
    // Astral characters count once rather than twice.
    expect(countCanvasPromptCharacters("a😀")).toBe(2);

    expect(normalizeCanvasCount(0)).toBe(1);
    expect(normalizeCanvasCount(3.7)).toBe(3);
    expect(normalizeCanvasCount(99)).toBe(8);
    expect(normalizeCanvasCount(Number.NaN)).toBe(1);
  });

  it("renders every parameter control, the key group and the derived size, and no price block", () => {
    const models = resolveCanvasImageModels(canvasConfig);
    const markup = renderToStaticMarkup(
      createElement(MultimediaCanvasSettingsPanel, {
        settings: createCanvasSettings(canvasConfig),
        models,
        onChange: () => {}
      })
    );

    for (const label of [
      "生成方式",
      "文生图",
      "图生图",
      "API Key",
      "模型",
      "画面描述",
      "质量",
      "分辨率",
      "画面比例",
      "输出大小",
      "生成数量"
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("FLUX Pro · 本地网关");
    expect(markup).toContain("1024 × 1024 · 1 张");
    expect(markup).toContain("未配置");
    // Requirements explicitly exclude pricing from this panel.
    expect(markup).not.toContain("价格");
    expect(markup).not.toContain("¥");
  });

  it("flags a missing key for the selected provider and reports an empty model list", () => {
    const withKey = renderToStaticMarkup(
      createElement(MultimediaCanvasSettingsPanel, {
        settings: { ...createCanvasSettings(canvasConfig), modelValue: "openai::gpt-image-1" },
        models: resolveCanvasImageModels(canvasConfig),
        onChange: () => {}
      })
    );
    expect(withKey).toContain("已配置");

    const empty = renderToStaticMarkup(
      createElement(MultimediaCanvasSettingsPanel, {
        settings: createCanvasSettings(null),
        models: [],
        onChange: () => {}
      })
    );
    expect(empty).toContain("尚未配置图片模型");
  });

  it("styles the settings panel through canvas-scoped rules", () => {
    expect(canvasStyles).toContain(".multimedia-canvas-settings-panel {");
    expect(canvasStyles).toContain(".multimedia-canvas-segmented button.active {");
    expect(canvasStyles).toContain(".multimedia-canvas-prompt {");
    expect(canvasStyles).toContain(".multimedia-canvas-output-size {");
  });
});
