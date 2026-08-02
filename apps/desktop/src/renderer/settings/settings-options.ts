import type { AppConfig, DatabasePermission } from "@shared-types";

export const SKILL_SORT_OPTIONS = [
  { value: "name", label: "\u540d\u79f0" },
  { value: "calls", label: "\u8c03\u7528\u6b21\u6570" },
  { value: "success", label: "\u6210\u529f\u7387" }
] as const;

export function getSkillSortLabel(value: "name" | "calls" | "success"): string {
  return SKILL_SORT_OPTIONS.find((option) => option.value === value)?.label ?? SKILL_SORT_OPTIONS[0].label;
}

export const RESPONSE_TONE_OPTIONS: Array<{
  value: AppConfig["responseTone"];
  label: string;
  description: string;
}> = [
  { value: "friendly", label: "亲和", description: "自然、温和、清晰" },
  { value: "concise", label: "简约", description: "直接、精炼、聚焦结果" }
];

export const DATABASE_PERMISSION_OPTIONS: Array<{ value: DatabasePermission; label: string }> = [
  { value: "query", label: "查询" },
  { value: "insert", label: "新增" },
  { value: "update", label: "更新" },
  { value: "delete", label: "删除" }
];
