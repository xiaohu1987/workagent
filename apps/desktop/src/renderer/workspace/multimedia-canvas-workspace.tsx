import { useMemo, useState } from "react";
import type { AppConfig } from "@shared-types";
import { IconImage } from "../icons";
import { WorkspaceEmptyState } from "./panels";
import { MultimediaCanvasSettingsPanel } from "./multimedia-canvas-settings-panel";
import {
  createCanvasSettings,
  resolveCanvasImageModels,
  resolveCanvasModelValue,
  type CanvasSettingsState
} from "./multimedia-canvas-settings";
import "./multimedia-canvas.css";

/**
 * 多媒体画布视图：通过侧边栏「多媒体画布」入口打开后占据主区域，
 * 用于集中生成与管理图片、视频创作。
 *
 * 组件常驻挂载并持有创作参数，因此切回任务再回到画布时参数与创作记录都不会重置。
 * 模型清单与密钥就绪状态从传入的多模态图片模型配置推导，不在渲染进程读取密钥内容。
 */
export function MultimediaCanvasWorkspace({
  active = false,
  config = null
}: {
  active?: boolean;
  config?: AppConfig | null;
}) {
  const models = useMemo(() => resolveCanvasImageModels(config), [config]);
  const [settings, setSettings] = useState<CanvasSettingsState>(() => createCanvasSettings(null));
  // 配置是异步到达的：默认模型只在初始状态里选一次会一直为空，
  // 因此每轮渲染都按当前模型清单校正选中项，不额外引入副作用。
  const modelValue = resolveCanvasModelValue(models, settings.modelValue);
  const resolvedSettings = modelValue === settings.modelValue ? settings : { ...settings, modelValue };

  return (
    <section
      className={`multimedia-canvas${active ? " is-active" : ""}`}
      aria-label="多媒体画布"
      aria-hidden={active ? undefined : true}
    >
      <header className="multimedia-canvas-header">
        <div className="multimedia-canvas-title">
          <span className="multimedia-canvas-title-icon" aria-hidden="true">
            <IconImage />
          </span>
          <strong>多媒体画布</strong>
        </div>
        <p className="multimedia-canvas-subtitle">
          集中生成图片与视频；生成结果只保存到本地文件夹，不会写入会话记录。
        </p>
      </header>
      <div className="multimedia-canvas-columns">
        <section className="multimedia-canvas-column multimedia-canvas-settings" aria-label="创作设置">
          <h2 className="multimedia-canvas-column-title">创作设置</h2>
          <div className="multimedia-canvas-column-body">
            <MultimediaCanvasSettingsPanel
              settings={resolvedSettings}
              models={models}
              onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
            />
          </div>
        </section>
        <section className="multimedia-canvas-column multimedia-canvas-preview" aria-label="预览区域">
          <h2 className="multimedia-canvas-column-title">预览区域</h2>
          <div className="multimedia-canvas-column-body">
            <WorkspaceEmptyState
              icon={<IconImage />}
              title="等待创建图片"
              message="在左侧填写提示词并选择模型后开始生成，结果会显示在这里。"
            />
          </div>
        </section>
        <section className="multimedia-canvas-column multimedia-canvas-records" aria-label="创作记录">
          <h2 className="multimedia-canvas-column-title">创作记录</h2>
          <div className="multimedia-canvas-column-body">
            <WorkspaceEmptyState
              icon={<IconImage />}
              title="暂无创作记录"
              message="生成过的图片会按时间顺序记录在这里。"
            />
          </div>
        </section>
      </div>
    </section>
  );
}
