import type { Dispatch, SetStateAction } from "react";
import { SIDEBAR_NAV_ITEM_IDS, type AppConfig, type SidebarNavItemId } from "@shared-types";
import { SIDEBAR_NAV_ITEM_LABELS } from "../../../history/sidebar-nav-items";

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
      <div className="config-block general-tone-settings">
        <div className="section-copy">
          <strong>侧栏入口</strong>
          <span>勾选的入口直接显示在侧栏；未勾选的入口收进「更多」，鼠标移到「更多」上时侧滑展开。</span>
        </div>
        <div className="memory-option-row">
          {SIDEBAR_NAV_ITEM_IDS.map((id) => {
            const shown = !hiddenItems.includes(id);
            return (
              <label key={id} className="memory-option" title={SIDEBAR_NAV_ITEM_DESCRIPTIONS[id]}>
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={(event) => toggleItem(id, event.target.checked)}
                />
                <span>{SIDEBAR_NAV_ITEM_LABELS[id]}</span>
              </label>
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
