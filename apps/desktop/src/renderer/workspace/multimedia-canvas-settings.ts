import type { AppConfig } from "@shared-types";
import { getProviderDisplayName, hasStoredSecret, modelKey } from "../lib/config-utils";

/**
 * 多媒体画布的纯逻辑层：模型数据源、参数状态与联动换算。
 *
 * 这里不引入任何写死的模型清单——图片模型一律从「设置 → 多模态」的
 * `models[].role === "image"` 与 `multimodal.image` 默认项推导，供应商
 * 名称与密钥就绪状态复用 config-utils 的既有实现。
 */

export type CanvasGenerationMode = "text_to_image" | "image_to_image";

export interface CanvasImageModelOption {
  /** `providerId::modelId`，复用 config-utils 的 modelKey 约定。 */
  value: string;
  label: string;
  providerId: string;
  modelId: string;
  providerName: string;
  /** 供应商是否已配置密钥；画布不在渲染进程读取密钥本身。 */
  hasApiKey: boolean;
  /** 是否为「设置 → 多模态」指定的图片默认模型。 */
  isDefault: boolean;
}

export interface CanvasSizeOption {
  id: string;
  label: string;
}

export interface CanvasResolutionOption extends CanvasSizeOption {
  /** 生成结果长边的像素上限，短边按画面比例换算。 */
  longEdge: number;
}

export interface CanvasAspectRatioOption extends CanvasSizeOption {
  widthRatio: number;
  heightRatio: number;
}

export interface CanvasSettingsState {
  mode: CanvasGenerationMode;
  /** 对应 CanvasImageModelOption.value；无可用模型时为空字符串。 */
  modelValue: string;
  prompt: string;
  qualityId: string;
  resolutionId: string;
  aspectRatioId: string;
  count: number;
}

export interface CanvasOutputSize {
  width: number;
  height: number;
  count: number;
  /** 供面板直接展示的尺寸摘要，例如 `1024 × 1024 · 2 张`。 */
  label: string;
}

export const CANVAS_MIN_COUNT = 1;
export const CANVAS_MAX_COUNT = 8;

/** 分辨率、比例、数量为画布自身的画面参数，与模型清单无关。 */
export const CANVAS_RESOLUTION_OPTIONS: CanvasResolutionOption[] = [
  { id: "1k", label: "1K", longEdge: 1024 },
  { id: "2k", label: "2K", longEdge: 2048 },
  { id: "4k", label: "4K", longEdge: 4096 }
];

export const CANVAS_ASPECT_RATIO_OPTIONS: CanvasAspectRatioOption[] = [
  { id: "1:1", label: "1:1", widthRatio: 1, heightRatio: 1 },
  { id: "4:3", label: "4:3", widthRatio: 4, heightRatio: 3 },
  { id: "3:4", label: "3:4", widthRatio: 3, heightRatio: 4 },
  { id: "16:9", label: "16:9", widthRatio: 16, heightRatio: 9 },
  { id: "9:16", label: "9:16", widthRatio: 9, heightRatio: 16 }
];

export const CANVAS_QUALITY_OPTIONS: CanvasSizeOption[] = [
  { id: "standard", label: "标准" },
  { id: "high", label: "高清" }
];

export const CANVAS_MODE_OPTIONS: Array<{ id: CanvasGenerationMode; label: string }> = [
  { id: "text_to_image", label: "文生图" },
  { id: "image_to_image", label: "图生图" }
];

const findOrFirst = <T extends { id: string }>(options: T[], id: string): T =>
  options.find((option) => option.id === id) ?? options[0];

/**
 * 从多模态图片模型配置推导下拉选项。返回顺序为：默认模型优先，其余按配置顺序。
 * 图片模型未配置时返回空数组，由面板给出占位提示，而不是回退到写死清单。
 */
export function resolveCanvasImageModels(config: AppConfig | null): CanvasImageModelOption[] {
  if (!config) return [];
  const imageDefaults = config.multimodal?.image;
  const options = config.models
    .filter((model) => model.role === "image")
    .map((model) => {
      const provider = config.providers.find((entry) => entry.id === model.providerId) ?? null;
      const providerName = provider ? getProviderDisplayName(provider) : model.providerId;
      const isDefault =
        imageDefaults?.defaultProviderId === model.providerId &&
        imageDefaults?.defaultModelId === model.id;
      const providerSuffix = providerName === model.displayName ? "" : ` · ${providerName}`;
      return {
        value: modelKey(model.providerId, model.id),
        label: `${model.displayName}${providerSuffix}`,
        providerId: model.providerId,
        modelId: model.id,
        providerName,
        hasApiKey: provider ? hasStoredSecret(provider) : false,
        isDefault
      };
    });

  if (imageDefaults?.enabled === false) return options;

  return options.sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
}

/** 模型被删除或未配置时，默认选中多模态指定的默认图片模型，其次取首个可用项。 */
export function resolveCanvasModelValue(
  models: CanvasImageModelOption[],
  currentValue: string
): string {
  if (models.some((model) => model.value === currentValue)) return currentValue;
  return models.find((model) => model.isDefault)?.value ?? models[0]?.value ?? "";
}

export function createCanvasSettings(config: AppConfig | null): CanvasSettingsState {
  const models = resolveCanvasImageModels(config);
  return {
    mode: "text_to_image",
    modelValue: resolveCanvasModelValue(models, ""),
    prompt: "",
    qualityId: CANVAS_QUALITY_OPTIONS[0].id,
    resolutionId: CANVAS_RESOLUTION_OPTIONS[0].id,
    aspectRatioId: CANVAS_ASPECT_RATIO_OPTIONS[0].id,
    count: 1
  };
}

/** 按 Unicode 码点计数，避免表情等代理对被算成两个字符。 */
export function countCanvasPromptCharacters(prompt: string): number {
  return Array.from(prompt).length;
}

export function normalizeCanvasCount(raw: number): number {
  if (!Number.isFinite(raw)) return CANVAS_MIN_COUNT;
  return Math.min(CANVAS_MAX_COUNT, Math.max(CANVAS_MIN_COUNT, Math.floor(raw)));
}

/** 与常见图片接口对齐：边长取 8 的整数倍。 */
const toMultipleOfEight = (value: number): number => Math.max(8, Math.round(value / 8) * 8);

/**
 * 输出大小的唯一换算入口：长边取所选分辨率，短边按画面比例推导，
 * 因此分辨率、比例任一变化都会同步刷新尺寸，生成数量只影响摘要中的张数。
 */
export function resolveCanvasOutputSize(input: {
  resolutionId: string;
  aspectRatioId: string;
  count: number;
}): CanvasOutputSize {
  const resolution = findOrFirst(CANVAS_RESOLUTION_OPTIONS, input.resolutionId);
  const ratio = findOrFirst(CANVAS_ASPECT_RATIO_OPTIONS, input.aspectRatioId);
  const landscape = ratio.widthRatio >= ratio.heightRatio;
  const width = toMultipleOfEight(
    landscape
      ? resolution.longEdge
      : (resolution.longEdge * ratio.widthRatio) / ratio.heightRatio
  );
  const height = toMultipleOfEight(
    landscape
      ? (resolution.longEdge * ratio.heightRatio) / ratio.widthRatio
      : resolution.longEdge
  );
  const count = normalizeCanvasCount(input.count);
  return { width, height, count, label: `${width} × ${height} · ${count} 张` };
}

export function toCanvasSizeOptions(options: CanvasSizeOption[]): Array<{ value: string; label: string }> {
  return options.map((option) => ({ value: option.id, label: option.label }));
}
