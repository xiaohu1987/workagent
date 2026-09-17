import path from "node:path";
import type { ShareFormat, ShareLaunchMethod, ShareTarget } from "@shared-types";

export const SHARE_TARGETS: readonly ShareTarget[] = ["wechat", "dingtalk"] as const;

export const SHARE_TARGET_LABELS: Record<ShareTarget, string> = {
  wechat: "微信",
  dingtalk: "钉钉"
};

/**
 * Custom URL schemes registered by the desktop clients. Used as a fallback when
 * no executable can be located, and to bring an already running client forward.
 */
export const SHARE_TARGET_PROTOCOLS: Record<ShareTarget, string> = {
  wechat: "weixin://",
  dingtalk: "dingtalk://"
};

/**
 * Executables that can front a share. WeChat 4.x ships as Weixin.exe while 3.x
 * ships as WeChat.exe; DingTalk ships a launcher next to the main binary.
 */
export const SHARE_TARGET_EXECUTABLES: Record<ShareTarget, string[]> = {
  wechat: ["WeChat.exe", "Weixin.exe"],
  dingtalk: ["DingTalk.exe", "DingtalkLauncher.exe"]
};

/** Registry keys that store an install path, probed as `key /v value`. */
export const SHARE_TARGET_REGISTRY_KEYS: Record<ShareTarget, Array<{ key: string; value: string }>> = {
  wechat: [
    { key: "HKCU\\Software\\Tencent\\WeChat", value: "InstallPath" },
    { key: "HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\WeChat", value: "InstallPath" },
    { key: "HKLM\\SOFTWARE\\Tencent\\WeChat", value: "InstallPath" }
  ],
  dingtalk: [
    { key: "HKCU\\Software\\DingTalk", value: "InstallPath" },
    { key: "HKLM\\SOFTWARE\\WOW6432Node\\DingTalk", value: "InstallPath" },
    { key: "HKLM\\SOFTWARE\\DingTalk", value: "InstallPath" }
  ]
};

/** Plain text for WeChat: it does not render markdown. DingTalk renders markdown. */
export function resolveShareFormat(target: ShareTarget): ShareFormat {
  return target === "dingtalk" ? "markdown" : "text";
}

export function isShareTarget(value: unknown): value is ShareTarget {
  return value === "wechat" || value === "dingtalk";
}

/**
 * Parse `reg query` output for a single value. Both named values and the
 * `(Default)` value of an App Paths key use the same `NAME  REG_SZ  DATA`
 * column layout, so the type token is used as the anchor instead of column
 * offsets (install paths routinely contain spaces).
 */
export function parseRegistryValueOutput(stdout: string, valueName: string | null): string | null {
  const wanted = (valueName ?? "(Default)").toLocaleLowerCase();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(.*?)\s+(REG_[A-Z_]+)\s*(.*)$/);
    if (!match) continue;
    const name = (match[1] ?? "").trim().toLocaleLowerCase();
    if (name !== wanted) continue;
    const data = (match[3] ?? "").trim();
    if (data) return data;
  }
  return null;
}

/**
 * Expand the conventional install locations for a client. Windows environment
 * variables are injected so the helper stays pure and testable.
 */
export function getShareAppSearchPaths(target: ShareTarget, env: Record<string, string | undefined>): string[] {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? programFiles;
  const localAppData = env.LOCALAPPDATA ?? "";
  const directoriesByTarget: Record<ShareTarget, string[]> = {
    wechat: [
      path.join(programFilesX86, "Tencent", "WeChat"),
      path.join(programFiles, "Tencent", "WeChat"),
      path.join(programFilesX86, "Tencent", "Weixin"),
      path.join(programFiles, "Tencent", "Weixin"),
      localAppData ? path.join(localAppData, "Tencent", "WeChat") : ""
    ],
    dingtalk: [
      path.join(programFilesX86, "DingDing"),
      path.join(programFiles, "DingDing"),
      localAppData ? path.join(localAppData, "DingDing", "main", "current") : "",
      localAppData ? path.join(localAppData, "DingTalk") : ""
    ]
  };
  const directories = directoriesByTarget[target].filter(Boolean);
  return directories.flatMap((directory) =>
    SHARE_TARGET_EXECUTABLES[target].map((executable) => path.join(directory, executable))
  );
}

/**
 * Registry install paths may point at the install directory rather than the
 * executable. Strip quotes/trailing separators so callers can probe both.
 */
export function normalizeExecutablePath(candidate: string): string {
  const trimmed = (candidate ?? "").replace(/^"|"$/g, "").trim();
  if (/\.exe$/i.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

/**
 * Resolve how the client will be brought forward. An executable is preferred
 * because the custom scheme only works for clients that registered it.
 */
export function planShareLaunch(
  target: ShareTarget,
  input: { registryPath?: string | null; existingPaths?: readonly string[] }
): { method: ShareLaunchMethod; value: string | null } {
  const candidate = input.registryPath?.trim() || input.existingPaths?.find((item) => item.trim())?.trim();
  if (candidate) {
    return { method: "app-path", value: normalizeExecutablePath(candidate) };
  }
  return { method: "protocol", value: SHARE_TARGET_PROTOCOLS[target] };
}
