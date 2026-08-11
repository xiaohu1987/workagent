import { useEffect, useState, type MutableRefObject, type PointerEventHandler } from "react";
import { IconImage, IconRefresh, IconTrash, IconUpload } from "../../../icons";
import {
  CHAT_BACKGROUND_SURFACE_OPTIONS,
  getChatBackgroundTransform,
  type ChatBackgroundMode,
  type ChatBackgroundSettings,
  type ChatBackgroundSurfaceKey,
  type ChatBackgroundSurfaces
} from "../../../chat-background";
import idleVideo from "../../../assets/realtime-state-idle.mp4";

type ChatBackgroundImage = {
  id: string;
  fileName: string;
  mimeType: string;
  bytes: ArrayBuffer;
  url: string;
};

type ChatBackgroundSettingsPatch = Partial<Omit<ChatBackgroundSettings, "surfaces">> & {
  surfaces?: Partial<ChatBackgroundSurfaces>;
};

const CHAT_BACKGROUND_MODE_OPTIONS: ReadonlyArray<{
  value: ChatBackgroundMode;
  label: string;
}> = [
  { value: "none", label: "无背景" },
  { value: "image", label: "图片背景" },
  { value: "dynamic", label: "动态背景" }
];

type AppearanceSettingsPageProps = {
  inputRef: MutableRefObject<HTMLInputElement | null>;
  images: ChatBackgroundImage[];
  activeImageIndex: number;
  imageUrl: string | null;
  settings: ChatBackgroundSettings;
  backgroundMode: ChatBackgroundMode;
  isDragging: boolean;
  onImportFiles: (files: File[]) => Promise<void>;
  onSelectImage: (index: number) => void;
  onMoveImage: (sourceId: string, targetId: string) => Promise<void>;
  onRemoveImage: (id: string) => Promise<void>;
  onUpdateSettings: (patch: ChatBackgroundSettingsPatch) => void;
  onBackgroundModeChange: (mode: ChatBackgroundMode) => void;
  onUpdateSurface: (key: ChatBackgroundSurfaceKey, value: number) => void;
  onBeginDrag: PointerEventHandler<HTMLImageElement>;
  onMoveDrag: PointerEventHandler<HTMLImageElement>;
  onEndDrag: PointerEventHandler<HTMLImageElement>;
  onResetSurfaces: () => void;
  onClear: () => Promise<void>;
};

export function AppearanceSettingsPage({
  inputRef,
  images,
  activeImageIndex,
  imageUrl,
  settings,
  backgroundMode,
  isDragging,
  onImportFiles,
  onSelectImage,
  onMoveImage,
  onRemoveImage,
  onUpdateSettings,
  onBackgroundModeChange,
  onUpdateSurface,
  onBeginDrag,
  onMoveDrag,
  onEndDrag,
  onResetSurfaces,
  onClear
}: AppearanceSettingsPageProps) {
  // 界面展示的页签跟随实际生效的背景模式;但没有图片时也允许切到"图片背景"页签去导入
  const [viewMode, setViewMode] = useState<ChatBackgroundMode>(backgroundMode);
  useEffect(() => {
    setViewMode(backgroundMode);
  }, [backgroundMode]);

  const modePanel = (
    <section className="chat-background-mode-panel" aria-label="背景模式">
      <div className="chat-background-control-label">
        <span>背景模式</span>
        <em>三种模式互斥，只启用其中一种</em>
      </div>
      <div className="chat-background-mode-options" role="radiogroup" aria-label="背景模式">
        {CHAT_BACKGROUND_MODE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`chat-background-mode-option ${viewMode === option.value ? "is-selected" : ""}`}
          >
            <input
              type="radio"
              name="chat-background-mode"
              value={option.value}
              checked={viewMode === option.value}
              onChange={() => {
                setViewMode(option.value);
                onBackgroundModeChange(option.value);
              }}
            />
            <span className="chat-background-mode-radio" aria-hidden="true" />
            <span className="chat-background-mode-copy">
              <strong>{option.label}</strong>
            </span>
          </label>
        ))}
      </div>
    </section>
  );

  // 无背景:布局与其他模式一致,左侧预览框留空,右侧只保留模式选择
  if (viewMode === "none") {
    return (
      <div className="settings-section chat-background-settings">
        <div className="chat-background-editor">
          <div className="chat-background-preview-column">
            <div className="chat-background-preview" aria-hidden="true" />
          </div>
          <div className="chat-background-controls">{modePanel}</div>
        </div>
      </div>
    );
  }

  return (
      <div className="settings-section chat-background-settings">
        <input
          ref={inputRef}
          className="chat-background-file-input"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.currentTarget.value = "";
            if (files.length) void onImportFiles(files);
          }}
        />

        <div className="chat-background-editor">
          <div className="chat-background-preview-column">
            {viewMode === "dynamic" ? (
              <div className="chat-background-preview chat-background-preview-dynamic">
                <video src={idleVideo} autoPlay muted loop playsInline aria-label="动态背景待机画面预览" />
                <div className="chat-background-preview-ui" aria-hidden="true">
                  <div className="chat-background-preview-bar">
                    <span className="chat-background-preview-avatar" />
                    <strong>CodeXH</strong>
                  </div>
                  <div className="chat-background-preview-messages">
                    <span className="preview-bubble preview-bubble-assistant">动态背景随对话状态实时变化。</span>
                    <span className="preview-bubble preview-bubble-user">界面内容保持清晰可读。</span>
                  </div>
                </div>
              </div>
            ) : (
              <div
                className={`chat-background-preview ${imageUrl ? "is-positionable" : ""} ${isDragging ? "is-dragging" : ""}`}
                data-fit={settings.fit}
              >
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt="背景预览"
                  draggable={false}
                  onPointerDown={onBeginDrag}
                  onPointerMove={onMoveDrag}
                  onPointerUp={onEndDrag}
                  onPointerCancel={onEndDrag}
                  style={{
                    filter: `blur(${settings.blur}px)`,
                    opacity: settings.enabled ? settings.opacity / 100 : 0,
                    objectFit: settings.fit,
                    objectPosition: "center",
                    transform: getChatBackgroundTransform(settings)
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="chat-background-empty"
                  onClick={() => inputRef.current?.click()}
                >
                  <IconImage />
                  <span>导入背景图片</span>
                </button>
              )}
              {imageUrl ? (
                <div className="chat-background-preview-ui" aria-hidden="true">
                  <div className="chat-background-preview-bar">
                    <span className="chat-background-preview-avatar" />
                    <strong>CodeXH</strong>
                  </div>
                  <div className="chat-background-preview-messages">
                    <span className="preview-bubble preview-bubble-assistant">整个应用使用同一张背景。</span>
                    <span className="preview-bubble preview-bubble-user">界面内容保持清晰可读。</span>
                  </div>
                </div>
              ) : null}
              </div>
            )}

            {viewMode === "image" ? (
              <>
            <section className="chat-background-library" aria-label="背景图片管理">
              <div className="chat-background-library-header">
                <div className="chat-background-control-label">
                  <span>背景图片</span>
                  <em>{images.length ? "拖动图片调整轮播顺序" : "导入图片后可开启动态切换"}</em>
                </div>
                <button type="button" className="chat-background-add-button" onClick={() => inputRef.current?.click()}>
                  <IconUpload />
                  <span>{images.length ? "添加图片" : "导入图片"}</span>
                </button>
              </div>
              {images.length > 0 ? (
                <div className="chat-background-image-list">
                  {images.map((image, index) => (
                    <div
                      key={image.id}
                      className={`chat-background-image-item ${index === activeImageIndex ? "is-active" : ""}`}
                      draggable
                      onDragStart={(event) => event.dataTransfer.setData("text/plain", image.id)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        const sourceId = event.dataTransfer.getData("text/plain");
                        if (sourceId) void onMoveImage(sourceId, image.id);
                      }}
                    >
                      <button type="button" className="chat-background-image-select" onClick={() => onSelectImage(index)} title={`预览 ${image.fileName}`}>
                        <img src={image.url} alt="" />
                        <span>{image.fileName}</span>
                      </button>
                      <button type="button" className="chat-background-image-remove" onClick={() => void onRemoveImage(image.id)} title={`删除 ${image.fileName}`} aria-label={`删除 ${image.fileName}`}>
                        <IconTrash />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <button type="button" className="chat-background-library-empty" onClick={() => inputRef.current?.click()}>
                  <IconImage />
                  <span>导入图片开始设置</span>
                </button>
              )}
              <div className="chat-background-rotation-row">
                <div>
                  <strong>动态切换</strong>
                  <span>{images.length < 2 ? "添加至少两张图片后可用" : "按当前排序顺序循环播放"}</span>
                </div>
                <label className="chat-background-toggle">
                  <input
                    type="checkbox"
                    checked={settings.rotationEnabled}
                    disabled={images.length < 2}
                    onChange={(event) => onUpdateSettings({ rotationEnabled: event.target.checked })}
                  />
                  <span aria-hidden="true" />
                  <em>{settings.rotationEnabled ? "开启" : "关闭"}</em>
                </label>
              </div>
              <label className="chat-background-rotation-interval">
                <span>切换间隔</span>
                <input
                  type="range"
                  min="10"
                  max="600"
                  step="10"
                  value={settings.rotationIntervalSeconds}
                  disabled={images.length < 2 || !settings.rotationEnabled}
                  onChange={(event) => onUpdateSettings({ rotationIntervalSeconds: Number(event.target.value) })}
                />
                <output>{settings.rotationIntervalSeconds} 秒</output>
              </label>
            </section>

            <section className="chat-background-motion-panel" aria-label="背景动效">
              <div className="chat-background-control-label">
                <span>背景动效</span>
                <em>不使用视频模型</em>
              </div>
              <div className="chat-background-motion-settings chat-background-motion-settings-in-panel">
                <div className="chat-background-motion-setting">
                  <div>
                    <strong>缓慢镜头运动</strong>
                    <span>自动缩放与平移单张背景</span>
                  </div>
                  <label className="chat-background-toggle">
                    <input type="checkbox" checked={settings.motionEnabled} disabled={!imageUrl} onChange={(event) => onUpdateSettings({ motionEnabled: event.target.checked })} />
                    <span aria-hidden="true" />
                    <em>{settings.motionEnabled ? "开启" : "关闭"}</em>
                  </label>
                </div>
                <div className="chat-background-motion-setting">
                  <div>
                    <strong>鼠标视差</strong>
                    <span>背景随鼠标轻微跟随</span>
                  </div>
                  <label className="chat-background-toggle">
                    <input type="checkbox" checked={settings.parallaxEnabled} disabled={!imageUrl} onChange={(event) => onUpdateSettings({ parallaxEnabled: event.target.checked })} />
                    <span aria-hidden="true" />
                    <em>{settings.parallaxEnabled ? "开启" : "关闭"}</em>
                  </label>
                </div>
                <div className="chat-background-motion-setting">
                  <div>
                    <strong>空间层次</strong>
                    <span>以远景和前景强化视差深度</span>
                  </div>
                  <label className="chat-background-toggle">
                    <input type="checkbox" checked={settings.depthEnabled} disabled={!imageUrl} onChange={(event) => onUpdateSettings({ depthEnabled: event.target.checked })} />
                    <span aria-hidden="true" />
                    <em>{settings.depthEnabled ? "开启" : "关闭"}</em>
                  </label>
                </div>
                <div className="chat-background-motion-setting">
                  <div>
                    <strong>氛围光影</strong>
                    <span>缓慢掠过的柔和光线</span>
                  </div>
                  <label className="chat-background-toggle">
                    <input type="checkbox" checked={settings.atmosphereEnabled} disabled={!imageUrl} onChange={(event) => onUpdateSettings({ atmosphereEnabled: event.target.checked })} />
                    <span aria-hidden="true" />
                    <em>{settings.atmosphereEnabled ? "开启" : "关闭"}</em>
                  </label>
                </div>
              </div>
            </section>
              </>
            ) : null}

          </div>

          <div className="chat-background-controls">
            {modePanel}

            {viewMode === "dynamic" ? (
              <div className="chat-background-heading">
                <div>
                  <strong>动态背景</strong>
                  <span>待机画面循环播放，随对话状态自动切换</span>
                </div>
              </div>
            ) : (
              <>
            <div className="chat-background-heading">
              <div>
                <strong>显示效果</strong>
                <span>{imageUrl ? "画面显示与模块可读性" : "导入背景图片后可调整"}</span>
              </div>
            </div>

            <div className="chat-background-visual-controls">
            <div className="chat-background-control-group chat-background-fit-control">
              <div className="chat-background-control-label">
                <span>填充方式</span>
              </div>
              <div className="chat-background-segmented" role="group" aria-label="背景填充方式">
                <button
                  type="button"
                  className={settings.fit === "cover" ? "active" : ""}
                  onClick={() => onUpdateSettings({ fit: "cover" })}
                >
                  填满
                </button>
                <button
                  type="button"
                  className={settings.fit === "contain" ? "active" : ""}
                  onClick={() => onUpdateSettings({ fit: "contain" })}
                >
                  完整显示
                </button>
              </div>
            </div>

            <label className="chat-background-control-group">
              <div className="chat-background-control-label">
                <span>图片缩放</span>
                <output>{settings.zoom}%</output>
              </div>
              <input
                type="range"
                min="100"
                max="180"
                step="1"
                value={settings.zoom}
                disabled={!imageUrl}
                onChange={(event) => onUpdateSettings({ zoom: Number(event.target.value) })}
              />
            </label>

            <label className="chat-background-control-group">
              <div className="chat-background-control-label">
                <span>模糊度</span>
                <output>{settings.blur}px</output>
              </div>
              <input
                type="range"
                min="0"
                max="30"
                step="1"
                value={settings.blur}
                onChange={(event) => onUpdateSettings({ blur: Number(event.target.value) })}
              />
            </label>

            <label className="chat-background-control-group">
              <div className="chat-background-control-label">
                <span>背景图透明度</span>
                <output>{settings.opacity}%</output>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={settings.opacity}
                onChange={(event) => onUpdateSettings({ opacity: Number(event.target.value) })}
              />
            </label>
            </div>

            <div className="chat-background-control-group chat-background-surface-group">
              <div className="chat-background-control-label">
                <span>模块不透明度</span>
                <em>数值越高，遮罩越实</em>
              </div>
              <div className="chat-background-surface-controls">
                {CHAT_BACKGROUND_SURFACE_OPTIONS.map((option) => (
                  <label key={option.key} title={option.hint}>
                    <span>{option.label}</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      value={settings.surfaces[option.key]}
                      disabled={!imageUrl || !settings.enabled}
                      onChange={(event) => onUpdateSurface(option.key, Number(event.target.value))}
                    />
                    <output>{settings.surfaces[option.key]}%</output>
                  </label>
                ))}
              </div>
            </div>

            <div className="chat-background-actions">
              <button
                type="button"
                onClick={onResetSurfaces}
                title="将模块不透明度恢复为默认值"
              >
                <IconRefresh />
                <span>重置</span>
              </button>
              <button type="button" className="background-action-danger" onClick={() => void onClear()} disabled={!imageUrl} title="清除应用背景">
                <IconTrash />
                <span>清除</span>
              </button>
            </div>
              </>
            )}
          </div>
        </div>
      </div>
  );
}
