import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type { AppConfig, GpaState, MultiAgentMode, SkillMetadata } from "@shared-types";
import type { ApiCardFavorite } from "../api-card-favorites";
import type { ComposerAttachmentInput } from "../lib/conversation-utils";
import {
  IconChevronRight,
  IconFile,
  IconGlobe,
  IconGpa,
  IconImage,
  IconKnowledge,
  IconMcp,
  IconShield,
  IconSkills,
  IconVideo
} from "../icons";
import { FloatingSideMenu } from "./model-controls";

type ComposerAddMenuView = "root" | "skills" | "mcp" | "database" | "apiCards";

type ComposerAddMenuProps = {
  position: { left: number; top: number };
  motionPhase?: string;
  open: boolean;
  view: ComposerAddMenuView;
  submenuAnchor: HTMLElement | null;
  config: AppConfig | null;
  gpaState: GpaState;
  multiAgentMode: MultiAgentMode;
  isProjectThread: boolean;
  canAttachMultimodal: boolean;
  canGenerateImage: boolean;
  canGenerateVideo: boolean;
  mediaIntent: "image" | "video" | null;
  onSelectMediaIntent: (intent: "image" | "video") => void;
  skills: SkillMetadata[];
  filteredSkills: SkillMetadata[];
  apiCardFavorites: ApiCardFavorite[];
  apiCardMatches: ApiCardFavorite[];
  skillsQuery: string;
  apiCardQuery: string;
  onClose: () => void;
  onChooseFiles: (imagesOnly: boolean) => void | Promise<void>;
  onOpenSubmenu: (view: Exclude<ComposerAddMenuView, "root">, anchor: HTMLElement) => void;
  onSetView: (view: ComposerAddMenuView) => void;
  onSetSkillsQuery: (query: string) => void;
  onSetApiCardQuery: (query: string) => void;
  onAddAttachment: (attachment: ComposerAttachmentInput) => void;
  onSendApiCard: (favorite: ApiCardFavorite) => void | Promise<void>;
  onSetFullAccess: (enabled: boolean) => void | Promise<void>;
  onSetKnowledgeEnabled: (enabled: boolean) => void | Promise<void>;
  onSetMultiAgentMode: (mode: MultiAgentMode) => void | Promise<void>;
  onEnableGpa: () => void | Promise<void>;
  onClearCloseTimer: () => void;
  onScheduleCloseTimer: () => void;
  isGeneratedUserSkill: (skill: SkillMetadata) => boolean;
  formatGpaStage: (stage: GpaState["stage"]) => string;
};

export function ComposerAddMenu({
  position,
  motionPhase,
  open,
  view,
  submenuAnchor,
  config,
  gpaState,
  multiAgentMode,
  isProjectThread,
  canAttachMultimodal,
  canGenerateImage,
  canGenerateVideo,
  mediaIntent,
  onSelectMediaIntent,
  skills,
  filteredSkills,
  apiCardFavorites,
  apiCardMatches,
  skillsQuery,
  apiCardQuery,
  onClose,
  onChooseFiles,
  onOpenSubmenu,
  onSetView,
  onSetSkillsQuery,
  onSetApiCardQuery,
  onAddAttachment,
  onSendApiCard,
  onSetFullAccess,
  onSetKnowledgeEnabled,
  onSetMultiAgentMode,
  onEnableGpa,
  onClearCloseTimer,
  onScheduleCloseTimer,
  isGeneratedUserSkill,
  formatGpaStage
}: ComposerAddMenuProps) {
  const closeMenu = () => {
    onClose();
  };
  const resetToRoot = () => {
    onClearCloseTimer();
    onSetView("root");
  };
  const openSubmenu = (nextView: Exclude<ComposerAddMenuView, "root">, anchor: HTMLElement) => {
    onOpenSubmenu(nextView, anchor);
  };

  return createPortal(
    <>
      <div className="gpa-backdrop" data-motion={motionPhase} onMouseDown={closeMenu} />
      <div
        className="gpa-popover"
        data-motion={motionPhase}
        role="menu"
        onMouseEnter={onClearCloseTimer}
        onMouseLeave={onScheduleCloseTimer}
        style={{ position: "fixed", left: position.left, top: position.top, transform: "translateY(-100%)" }}
      >
        <>
          <button className="gpa-popover-item" role="menuitem" disabled={!canAttachMultimodal} title={!canAttachMultimodal ? "当前模型不支持多模态输入，且未配置默认多模态识别模型" : undefined} onMouseEnter={resetToRoot} onClick={() => void onChooseFiles(false)}>
            <span className="gpa-popover-item-icon" aria-hidden><IconFile /></span>
            <span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">添加文件</span><span className="gpa-popover-item-hint">选择文件作为任务上下文</span></span>
          </button>
          <button className="gpa-popover-item" role="menuitem" disabled={!canAttachMultimodal} title={!canAttachMultimodal ? "当前模型不支持多模态输入，且未配置默认多模态识别模型" : undefined} onMouseEnter={resetToRoot} onClick={() => void onChooseFiles(true)}>
            <span className="gpa-popover-item-icon" aria-hidden><IconImage /></span>
            <span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">添加图片</span><span className="gpa-popover-item-hint">选择图片作为视觉参考</span></span>
          </button>
          {canGenerateImage ? (
            <button className={`gpa-popover-item gpa-popover-item-generate-image ${mediaIntent === "image" ? "is-active" : ""}`} role="menuitemcheckbox" aria-checked={mediaIntent === "image"} onMouseEnter={resetToRoot} onClick={() => { onSelectMediaIntent("image"); closeMenu(); }}>
              <span className="gpa-popover-item-icon" aria-hidden><IconImage /></span>
              <span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">生成图片</span><span className="gpa-popover-item-hint">{mediaIntent === "image" ? "已选中，点击取消生成模式" : "输入描述，使用默认图片模型生成"}</span></span>
              {mediaIntent === "image" ? <span className="gpa-popover-item-check is-active">已开启</span> : null}
            </button>
          ) : null}
          {canGenerateVideo ? (
            <button className={`gpa-popover-item gpa-popover-item-generate-video ${mediaIntent === "video" ? "is-active" : ""}`} role="menuitemcheckbox" aria-checked={mediaIntent === "video"} onMouseEnter={resetToRoot} onClick={() => { onSelectMediaIntent("video"); closeMenu(); }}>
              <span className="gpa-popover-item-icon" aria-hidden><IconVideo /></span>
              <span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">生成视频</span><span className="gpa-popover-item-hint">{mediaIntent === "video" ? "已选中，点击取消生成模式" : "输入描述，使用默认视频模型生成"}</span></span>
              {mediaIntent === "video" ? <span className="gpa-popover-item-check is-active">已开启</span> : null}
            </button>
          ) : null}
          <MenuSubmenuButton icon={<IconGlobe />} title="接口卡片" hint="调用收藏的 API 卡片" view="apiCards" activeView={view} onOpen={openSubmenu} />
          <MenuSubmenuButton icon={<IconSkills />} title="Skills" hint="为本次任务添加专业技能" view="skills" activeView={view} onOpen={openSubmenu} />
          <MenuSubmenuButton icon={<IconMcp />} title="MCP 服务" hint="指定本次任务优先使用的服务" view="mcp" activeView={view} onOpen={openSubmenu} />
          <MenuSubmenuButton icon={<IconMcp />} title="数据库" hint="限定本轮可查询的数据源" view="database" activeView={view} onOpen={openSubmenu} />
          <div className="gpa-popover-divider" />
        </>
        <button className={`gpa-popover-item gpa-popover-item-full-access ${gpaState.fullAccess ? "is-active" : ""}`} role="menuitem" onMouseEnter={resetToRoot} disabled={gpaState.fullAccess} onClick={() => void onSetFullAccess(true)}>
          <span className="gpa-popover-item-icon" aria-hidden><IconShield /></span>
          <span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">完全访问</span><span className="gpa-popover-item-hint">文件和网络无需常规审批，明确授权仍会询问</span></span>
          {gpaState.fullAccess ? <span className="gpa-popover-item-check is-active">已开启</span> : null}
        </button>
        <button className={`gpa-popover-item gpa-popover-item-knowledge ${gpaState.knowledgeEnabled ? "is-active" : ""}`} role="menuitem" onMouseEnter={resetToRoot} disabled={gpaState.knowledgeEnabled} onClick={() => void onSetKnowledgeEnabled(true)}>
          <span className="gpa-popover-item-icon" aria-hidden><IconKnowledge /></span>
          <span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">开启知识库</span><span className="gpa-popover-item-hint">允许本对话检索本地知识库</span></span>
          {gpaState.knowledgeEnabled ? <span className="gpa-popover-item-check is-active">已开启</span> : null}
        </button>
        <button className={`gpa-popover-item gpa-popover-item-agent ${multiAgentMode === "proactive" ? "is-active" : ""}`} role="menuitem" onMouseEnter={resetToRoot} disabled={multiAgentMode === "proactive"} onClick={() => void onSetMultiAgentMode("proactive")}>
          <span className="gpa-popover-item-icon" aria-hidden><IconSkills /></span>
          <span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">子智能体</span><span className="gpa-popover-item-hint">为当前任务开启并行探索、审查与诊断</span></span>
          {multiAgentMode === "proactive" ? <span className="gpa-popover-item-check is-active">已开启</span> : null}
        </button>
        <button className={`gpa-popover-item gpa-popover-item-gpa ${gpaState.stage !== "off" ? "is-active" : ""}`} role="menuitem" onMouseEnter={resetToRoot} disabled={!isProjectThread} title={!isProjectThread ? "仅项目模式可开启 GPA" : gpaState.stage !== "off" ? "检查 GPA 状态" : undefined} onClick={() => void onEnableGpa()}>
          <span className="gpa-popover-item-icon" aria-hidden><IconGpa /></span>
          <span className="gpa-popover-item-copy">
            <span className="gpa-popover-item-title">{gpaState.stage !== "off" ? "GPA 已开启" : "开启 GPA"}</span>
            <span className="gpa-popover-item-hint">{isProjectThread ? gpaState.stage !== "off" ? `当前处于${formatGpaStage(gpaState.stage)}阶段，点击检查状态` : "目标、计划、执行三阶段工作流" : "仅项目对话可用，请先新建项目"}</span>
          </span>
          {gpaState.stage !== "off" ? <span className="gpa-popover-item-check is-active">已开启</span> : null}
        </button>
      </div>
      {open && view !== "root" ? (
        <FloatingSideMenu anchor={submenuAnchor} open={Boolean(submenuAnchor)} width={252} placementKey={view} className="composer-add-menu-submenu composer-add-menu-submenu-floating" onMouseEnter={onClearCloseTimer} onMouseLeave={onScheduleCloseTimer}>
          <div className="composer-add-menu-submenu-title">{view === "skills" ? "Skills" : view === "mcp" ? "MCP 服务" : view === "apiCards" ? "接口卡片" : "数据库"}</div>
          <div className="composer-add-menu-list">
            {view === "skills" ? (
              <>
                <div className="composer-add-menu-search"><input className="form-input composer-add-menu-search-input" type="text" placeholder="搜索 Skills" aria-label="搜索 Skills" value={skillsQuery} autoFocus onChange={(event) => onSetSkillsQuery(event.target.value)} /></div>
                {filteredSkills.length > 0 ? filteredSkills.map((skill) => (
                  <button key={skill.id} className={`gpa-popover-item${isGeneratedUserSkill(skill) ? " is-user-skill" : ""}`} role="menuitem" onClick={() => { onAddAttachment({ kind: "skill", skillId: skill.id, label: skill.displayName ?? skill.name, description: skill.shortDescription ?? skill.description }); closeMenu(); onSetSkillsQuery(""); }}>
                    <span className="gpa-popover-item-icon" aria-hidden><IconSkills /></span><span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">{skill.displayName ?? skill.name}</span><span className="gpa-popover-item-hint">{skill.shortDescription ?? skill.description}</span></span>
                  </button>
                )) : <span className="composer-add-menu-empty">{skills.length === 0 ? "没有可用的 Skills" : "没有匹配的 Skills"}</span>}
              </>
            ) : view === "mcp" ? (
              <EnabledMcpServers config={config} onAddAttachment={onAddAttachment} onClose={closeMenu} />
            ) : view === "apiCards" ? (
              <>
                <div className="composer-add-menu-search"><input className="form-input composer-add-menu-search-input" type="text" placeholder="搜索名称或 URL" aria-label="搜索收藏的接口卡片" value={apiCardQuery} autoFocus onChange={(event) => onSetApiCardQuery(event.target.value)} /></div>
                {apiCardMatches.length > 0 ? apiCardMatches.map((favorite) => (
                  <button key={favorite.id} className="gpa-popover-item" role="menuitem" onClick={() => { closeMenu(); onSetView("root"); onSetApiCardQuery(""); void onSendApiCard(favorite); }}>
                    <span className={`api-card-method is-${favorite.config.method.toLowerCase()}`}>{favorite.config.method}</span><span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">{favorite.name}</span><span className="gpa-popover-item-hint">{favorite.config.url}</span></span>
                  </button>
                )) : <span className="composer-add-menu-empty">{apiCardFavorites.length === 0 ? "还没有收藏的接口卡片,点击卡片右上角星标即可收藏" : "没有匹配的收藏卡片"}</span>}
              </>
            ) : (
              <EnabledDatabases config={config} onAddAttachment={onAddAttachment} onClose={closeMenu} />
            )}
          </div>
        </FloatingSideMenu>
      ) : null}
    </>,
    document.body
  );
}

type MenuSubmenuButtonProps = {
  icon: ReactNode;
  title: string;
  hint: string;
  view: Exclude<ComposerAddMenuView, "root">;
  activeView: ComposerAddMenuView;
  onOpen: (view: Exclude<ComposerAddMenuView, "root">, anchor: HTMLElement) => void;
};

function MenuSubmenuButton({ icon, title, hint, view, activeView, onOpen }: MenuSubmenuButtonProps) {
  return (
    <div className="composer-add-menu-item-with-submenu" onMouseEnter={(event) => onOpen(view, event.currentTarget)}>
      <button type="button" className="gpa-popover-item composer-add-menu-parent" role="menuitem" aria-haspopup="menu" aria-expanded={activeView === view} onFocus={(event) => onOpen(view, event.currentTarget)}>
        <span className="gpa-popover-item-icon" aria-hidden>{icon}</span><span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">{title}</span><span className="gpa-popover-item-hint">{hint}</span></span><IconChevronRight />
      </button>
    </div>
  );
}

function EnabledMcpServers({ config, onAddAttachment, onClose }: Pick<ComposerAddMenuProps, "config" | "onAddAttachment"> & { onClose: () => void }) {
  const servers = (config?.mcpServers ?? []).filter((server) => server.enabled);
  return <>{servers.map((server) => <button key={server.id} className="gpa-popover-item" role="menuitem" onClick={() => { onAddAttachment({ kind: "mcp", serverId: server.id, label: server.name, description: server.url ?? server.command ?? server.id }); onClose(); }}><span className="gpa-popover-item-icon" aria-hidden><IconMcp /></span><span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">{server.name}</span><span className="gpa-popover-item-hint">{server.url ?? server.command ?? server.id}</span></span></button>)}{servers.length === 0 ? <span className="composer-add-menu-empty">没有已启用的 MCP 服务</span> : null}</>;
}

function EnabledDatabases({ config, onAddAttachment, onClose }: Pick<ComposerAddMenuProps, "config" | "onAddAttachment"> & { onClose: () => void }) {
  const connections = (config?.databaseConnections ?? []).filter((connection) => connection.enabled);
  return <>{connections.map((connection) => <button key={connection.id} className="gpa-popover-item" role="menuitem" onClick={() => { onAddAttachment({ kind: "database", connectionId: connection.id, label: connection.name, description: `${connection.engine} · ${connection.host}:${connection.port}/${connection.database}` }); onClose(); }}><span className="gpa-popover-item-icon" aria-hidden><IconMcp /></span><span className="gpa-popover-item-copy"><span className="gpa-popover-item-title">{connection.name}</span><span className="gpa-popover-item-hint">{connection.engine} · {connection.host}</span></span></button>)}{connections.length === 0 ? <span className="composer-add-menu-empty">没有已启用的数据库</span> : null}</>;
}
