import type { ReactNode } from "react";
import { IconGear, IconGlobe, IconKnowledge, IconMcp, IconSinglePanel, IconSkills } from "../icons";
import type { SettingsTab } from "../core/app-types";

export type SettingsMenuGroup = {
  id: string;
  label: string;
  hint: string;
  tabs: SettingsTab[];
  icon: () => ReactNode;
};

export const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; hint: string }> = [
  { id: "timeouts", label: "通用设置", hint: "模型请求、重试、视频生成和子智能体的运行设置" },
  { id: "provider", label: "供应商设置", hint: "供应商、调用地址、密钥与模型列表" },
  { id: "multimodal", label: "多模态", hint: "配置默认多模态识别、生图与视频模型" },
  { id: "mcp", label: "MCP 管理", hint: "已配置的 MCP 服务" },
  { id: "database", label: "数据库", hint: "配置只读数据库并在聊天中调用" },
  { id: "knowledge", label: "知识库", hint: "导入、绑定和 OKF Bundle" },
  { id: "memory", label: "记忆", hint: "查看和清理错误解决方案记忆" },
  { id: "apiFavorites", label: "接口卡片", hint: "管理收藏的 API 卡片,从 + 菜单快速唤出" },
  { id: "capabilities", label: "能力中心", hint: "管理独立 Skill、用户技能和插件" },
  { id: "appearance", label: "应用背景", hint: "导入图片，并调整背景与各模块透明度" },
  { id: "usage", label: "统计", hint: "查看模型调用、Token 和缓存趋势" },
  { id: "update", label: "更新", hint: "检查、下载和安装 CodeXH 更新" }
];

export const SETTINGS_MENU_GROUPS: SettingsMenuGroup[] = [
  { id: "general", label: "通用设置", hint: "超时、重试和子智能体", tabs: ["timeouts"], icon: IconGear },
  { id: "models", label: "模型与供应商", hint: "供应商、模型与多模态", tabs: ["provider", "multimodal"], icon: IconGlobe },
  { id: "connections", label: "连接", hint: "MCP 与数据库", tabs: ["mcp", "database"], icon: IconMcp },
  { id: "knowledge", label: "知识与记忆", hint: "知识库与记忆", tabs: ["knowledge", "memory", "apiFavorites"], icon: IconKnowledge },
  { id: "capabilities", label: "能力中心", hint: "技能与插件", tabs: ["capabilities"], icon: IconSkills },
  { id: "application", label: "应用", hint: "外观、统计与更新", tabs: ["appearance", "usage", "update"], icon: IconSinglePanel }
];

export function getSettingsTitle(tab: SettingsTab): string {
  switch (tab) {
    case "provider": return "模型提供商";
    case "multimodal": return "多模态模型";
    case "appearance": return "应用背景";
    case "usage": return "统计";
    case "capabilities": return "能力中心";
    case "mcp": return "MCP 管理";
    case "knowledge": return "知识库";
    case "memory": return "记忆";
    case "timeouts": return "通用设置";
    case "update": return "应用更新";
    default: return "设置";
  }
}

export function getSettingsGroup(tab: SettingsTab): SettingsMenuGroup {
  return SETTINGS_MENU_GROUPS.find((group) => group.tabs.includes(tab)) ?? SETTINGS_MENU_GROUPS[0];
}
