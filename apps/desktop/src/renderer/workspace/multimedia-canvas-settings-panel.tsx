import { ComposerSelect } from "./composer-select";
import { IconPlus } from "../icons";
import {
  CANVAS_ASPECT_RATIO_OPTIONS,
  CANVAS_MAX_COUNT,
  CANVAS_MIN_COUNT,
  CANVAS_MODE_OPTIONS,
  CANVAS_QUALITY_OPTIONS,
  CANVAS_RESOLUTION_OPTIONS,
  countCanvasPromptCharacters,
  normalizeCanvasCount,
  resolveCanvasOutputSize,
  toCanvasSizeOptions,
  type CanvasImageModelOption,
  type CanvasSettingsState
} from "./multimedia-canvas-settings";

export type { CanvasSettingsState } from "./multimedia-canvas-settings";

/**
 * 创作设置面板：只负责呈现参数与回传改动，参数状态由画布持有，
 * 因此切回任务再回到画布时这些值不会被重置。
 *
 * 模型下拉的数据源完全来自多模态图片模型配置（models 由调用方推导）；
 * 这里再按「文生图 / 图生图」区分提示，并按需求不渲染任何价格区块。
 */
export function MultimediaCanvasSettingsPanel({
  settings,
  models,
  onChange
}: {
  settings: CanvasSettingsState;
  models: CanvasImageModelOption[];
  onChange: (patch: Partial<CanvasSettingsState>) => void;
}) {
  const outputSize = resolveCanvasOutputSize(settings);
  const promptLength = countCanvasPromptCharacters(settings.prompt);
  const selectedModel = models.find((model) => model.value === settings.modelValue) ?? null;

  return (
    <div className="multimedia-canvas-settings-panel">
      <div className="multimedia-canvas-field">
        <span className="multimedia-canvas-field-label">生成方式</span>
        <div className="multimedia-canvas-segmented" role="radiogroup" aria-label="生成方式">
          {CANVAS_MODE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={settings.mode === option.id}
              className={settings.mode === option.id ? "active" : undefined}
              onClick={() => onChange({ mode: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
        {settings.mode === "image_to_image" ? (
          <p className="multimedia-canvas-field-hint">
            图生图会以预览区域的参考图为输入；参考图选取将在图片生成链路中接入。
          </p>
        ) : null}
      </div>

      <div className="multimedia-canvas-group" aria-label="API Key">
        <div className="multimedia-canvas-group-head">
          <span className="multimedia-canvas-group-title">API Key</span>
          {selectedModel ? (
            <span
              className={`multimedia-canvas-key-state${selectedModel.hasApiKey ? " is-ready" : " is-missing"}`}
            >
              {selectedModel.hasApiKey ? "已配置" : "未配置"}
            </span>
          ) : null}
        </div>
        {selectedModel ? (
          <p className="multimedia-canvas-field-hint">
            {selectedModel.providerName}
            {selectedModel.hasApiKey
              ? " 的密钥读取自「设置 → 模型」，画布不会显示密钥内容。"
              : " 尚未配置密钥，请先到「设置 → 模型」补充后再生成。"}
          </p>
        ) : (
          <p className="multimedia-canvas-field-hint">
            尚未配置图片模型。请在「设置 → 多模态」指定图片模型后回到这里。
          </p>
        )}
      </div>

      <div className="multimedia-canvas-field">
        <span className="multimedia-canvas-field-label">模型</span>
        <ComposerSelect
          value={settings.modelValue}
          options={models.map((model) => ({ value: model.value, label: model.label }))}
          onChange={(value) => onChange({ modelValue: value })}
          placeholder="尚未配置图片模型"
          disabled={models.length === 0}
          ariaLabel="图片模型"
          searchable={models.length > 6}
          emptyLabel="尚未配置图片模型"
        />
      </div>

      <div className="multimedia-canvas-field">
        <span className="multimedia-canvas-field-label">
          画面描述
          <span className="multimedia-canvas-field-count">{promptLength}</span>
        </span>
        <textarea
          className="multimedia-canvas-prompt"
          value={settings.prompt}
          placeholder="描述想要生成的内容，例如：雨后的城市夜景，霓虹倒影，电影感光影"
          aria-label="画面描述"
          rows={5}
          onChange={(event) => onChange({ prompt: event.target.value })}
        />
      </div>

      <div className="multimedia-canvas-field">
        <span className="multimedia-canvas-field-label">质量</span>
        <div className="multimedia-canvas-segmented" role="radiogroup" aria-label="质量">
          {CANVAS_QUALITY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={settings.qualityId === option.id}
              className={settings.qualityId === option.id ? "active" : undefined}
              onClick={() => onChange({ qualityId: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="multimedia-canvas-field">
        <span className="multimedia-canvas-field-label">分辨率</span>
        <ComposerSelect
          value={settings.resolutionId}
          options={toCanvasSizeOptions(CANVAS_RESOLUTION_OPTIONS)}
          onChange={(value) => onChange({ resolutionId: value })}
          placeholder="选择分辨率"
          ariaLabel="分辨率"
        />
      </div>

      <div className="multimedia-canvas-field">
        <span className="multimedia-canvas-field-label">画面比例</span>
        <div className="multimedia-canvas-segmented" role="radiogroup" aria-label="画面比例">
          {CANVAS_ASPECT_RATIO_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={settings.aspectRatioId === option.id}
              className={settings.aspectRatioId === option.id ? "active" : undefined}
              onClick={() => onChange({ aspectRatioId: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="multimedia-canvas-field">
        <span className="multimedia-canvas-field-label">输出大小</span>
        <output className="multimedia-canvas-output-size" aria-live="polite">
          {outputSize.label}
        </output>
      </div>

      <div className="multimedia-canvas-field">
        <span className="multimedia-canvas-field-label">生成数量</span>
        <div className="multimedia-canvas-count" role="group" aria-label="生成数量">
          <button
            type="button"
            aria-label="减少生成数量"
            disabled={settings.count <= CANVAS_MIN_COUNT}
            onClick={() => onChange({ count: normalizeCanvasCount(settings.count - 1) })}
          >
            −
          </button>
          <span aria-live="polite">{settings.count}</span>
          <button
            type="button"
            aria-label="增加生成数量"
            disabled={settings.count >= CANVAS_MAX_COUNT}
            onClick={() => onChange({ count: normalizeCanvasCount(settings.count + 1) })}
          >
            <IconPlus />
          </button>
        </div>
      </div>
    </div>
  );
}
