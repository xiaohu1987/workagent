import type { ReactNode } from "react";
import type { SettingsTab } from "../core/app-types";
import { getSettingsGroup, getSettingsTitle, SETTINGS_MENU_GROUPS, SETTINGS_TABS } from "./settings-navigation";

export type SettingsNavigationGroup<TTab extends string> = {
  id: string;
  label: string;
  hint: string;
  tabs: TTab[];
  icon: () => ReactNode;
};

type SettingsDialogProps = {
  motionPhase?: string;
  activeTab: SettingsTab;
  onClose: () => void;
  onTabChange: (tab: SettingsTab) => void;
  closeIcon: ReactNode;
  children: ReactNode;
};

export function SettingsDialog({
  motionPhase,
  activeTab,
  onClose,
  onTabChange,
  closeIcon,
  children
}: SettingsDialogProps) {
  const activeGroup = getSettingsGroup(activeTab);
  const title = getSettingsTitle(activeTab);
  const TitleIcon = activeGroup.icon;

  return (
    <div className="settings-overlay motion-overlay" data-motion={motionPhase}>
      <div className="settings-dialog">
        <div className="settings-topbar">
          <h2><TitleIcon /><span>{title}</span></h2>
          <button className="settings-close-button" onClick={onClose} title="关闭">{closeIcon}</button>
        </div>
        <div className="settings-layout">
          <aside className="settings-sidebar">
            <div className="settings-tab-strip settings-tab-strip-vertical">
              {SETTINGS_MENU_GROUPS.map((group) => {
                const GroupIcon = group.icon;
                return <button key={group.id} className={`settings-strip-tab ${activeGroup.id === group.id ? "active" : ""}`} onClick={() => onTabChange(group.tabs[0])} title={group.hint}><GroupIcon /><span>{group.label}</span></button>;
              })}
            </div>
          </aside>
          <div className="settings-body">
            {activeGroup.tabs.length > 1 ? <div className="settings-subtab-bar" role="tablist" aria-label={`${activeGroup.label}分类`}>
              {activeGroup.tabs.map((tabId) => {
                const tab = SETTINGS_TABS.find((item) => item.id === tabId);
                return tab ? <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => onTabChange(tab.id)}>{tab.label}</button> : null;
              })}
            </div> : null}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
