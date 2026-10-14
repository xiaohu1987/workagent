import { SIDEBAR_NAV_ITEM_IDS, type SidebarNavItemId } from "@shared-types";

export type SidebarNavSplit = {
  /** Ids that keep their own button on the rail, in rail order. */
  visible: SidebarNavItemId[];
  /** Ids tucked behind the rail "更多" flyout, in rail order. */
  hidden: SidebarNavItemId[];
};

/** Rail label, shared by the rail button and the "更多" flyout entry. */
export const SIDEBAR_NAV_ITEM_LABELS: Record<SidebarNavItemId, string> = {
  quickNotes: "随手记",
  apiFavorites: "接口卡片",
  documentViewer: "查看文档",
  downloads: "下载"
};

/**
 * Splits the rail entries according to the config's hidden list. The config
 * file is hand editable, so unknown ids are ignored and the catalog order
 * always wins over whatever order the config happens to store.
 */
export function splitSidebarNavItems(hiddenItems?: readonly string[] | null): SidebarNavSplit {
  const hiddenIds = new Set(hiddenItems ?? []);
  const visible: SidebarNavItemId[] = [];
  const tucked: SidebarNavItemId[] = [];
  for (const id of SIDEBAR_NAV_ITEM_IDS) {
    if (hiddenIds.has(id)) {
      tucked.push(id);
    } else {
      visible.push(id);
    }
  }
  return { visible, hidden: tucked };
}
