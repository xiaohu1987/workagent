import type { Dispatch, SetStateAction } from "react";
import { SIDEBAR_NAV_ITEM_IDS, type AppConfig, type SidebarNavItemId } from "@shared-types";
import { SIDEBAR_NAV_ITEM_LABELS } from "../../../history/sidebar-nav-items";
import { SIDEBAR_NAV_ITEM_ICONS } from "../../../history/sidebar-nav-more";

type Props = {
  configDraft: AppConfig;
  setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>;
  onSave: (options?: { draft?: AppConfig; showSuccessNotice?: boolean }) => Promise<void>;
};

const SIDEBAR_NAV_ITEM_DESCRIPTIONS: Record<SidebarNavItemId, string> = {
  quickNotes: "随手记下片段，稍后可整段移到聊天里。",
  apiFavorites: "打开收藏的接口卡片。",
  documentViewer: "打开文档阅读视图。"
};

/**
 * "小工具" settings page: every sidebar entry renders as a square, app-icon
 * style tile. A lit tile keeps its rail button; a dim tile tucks into the
 * rail's "更多" flyout. Same hiddenSidebarItems config as before, only the
 * presentation changed.
 */
export function SidebarNavPage({ configDraft, setConfigDraft, onSave }: Props) {
  const hiddenItems = configDraft.desktop.hiddenSidebarItems ?? [];

  const updateAndSave = (nextDraft: AppConfig) => {
    setConfigDraft(nextDraft);
    void onSave({ draft: nextDraft, showSuccessNotice: false }).catch((error) => {
      console.error("[renderer] Failed to auto-save sidebar nav items", error);
    });
  };

  const toggleItem = (id: SidebarNavItemId, shown: boolean) => {
    const hidden = new Set<SidebarNavItemId>(hiddenItems);
    if (shown) hidden.delete(id);
    else hidden.add(id);
    updateAndSave({
      ...configDraft,
      desktop: { ...configDraft.desktop, hiddenSidebarItems: SIDEBAR_NAV_ITEM_IDS.filter((itemId) => hidden.has(itemId)) }
    });
  };

  return (
    <div className="settings-section">
      <div className="config-block gadgets-settings">
        <div className="section-copy">
          <strong>小工具</strong>
          <span>勾选的工具直接显示在侧栏；未勾选的收进「更多」，鼠标移到「更多」上时侧滑展开。</span>
        </div>
        <div className="gadgets-grid">
          {SIDEBAR_NAV_ITEM_IDS.map((id) => {
            const shown = !hiddenItems.includes(id);
            return (
              <button
                key={id}
                type="button"
                className={`gadget-tile ${shown ? "is-on" : "is-off"}`}
                title={SIDEBAR_NAV_ITEM_DESCRIPTIONS[id]}
                aria-pressed={shown}
                onClick={() => toggleItem(id, !shown)}
              >
                <span className="gadget-tile-check" aria-hidden>✓</span>
                <span className="gadget-tile-icon" aria-hidden>{SIDEBAR_NAV_ITEM_ICONS[id]}</span>
                <span className="gadget-tile-label">{SIDEBAR_NAV_ITEM_LABELS[id]}</span>
                <span className="gadget-tile-state">{shown ? "侧栏显示" : "收进更多"}</span>
              </button>
            );
          })}
        </div>
        <div className="settings-save-row">
          <span className="subtle-inline">全部取消勾选后侧栏只保留「新建任务」；有隐藏入口时才会出现「更多」。</span>
        </div>
      </div>
    </div>
  );
}
