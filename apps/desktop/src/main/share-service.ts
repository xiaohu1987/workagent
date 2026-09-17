import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { app, clipboard, dialog, nativeImage, shell } from "electron";
import type {
  ShareChannel,
  ShareImageRequest,
  ShareImageResult,
  ShareLaunchMethod,
  ShareSendRequest,
  ShareSendResult,
  ShareTarget,
  ShareTargetStatus
} from "@shared-types";
import {
  SHARE_TARGET_EXECUTABLES,
  SHARE_TARGET_LABELS,
  SHARE_TARGET_PROTOCOLS,
  SHARE_TARGET_REGISTRY_KEYS,
  SHARE_TARGETS,
  getShareAppSearchPaths,
  normalizeExecutablePath,
  parseRegistryValueOutput,
  planShareLaunch,
  resolveShareFormat
} from "./share-targets";

export {
  SHARE_TARGETS,
  SHARE_TARGET_LABELS,
  SHARE_TARGET_PROTOCOLS,
  SHARE_TARGET_EXECUTABLES,
  resolveShareFormat,
  isShareTarget,
  parseRegistryValueOutput,
  getShareAppSearchPaths,
  normalizeExecutablePath,
  planShareLaunch
} from "./share-targets";

function queryRegistryValue(args: string[], valueName: string | null): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile("reg.exe", args, { windowsHide: true }, (error, stdout) => {
      resolve(error ? null : parseRegistryValueOutput(stdout ?? "", valueName));
    });
  });
}

/**
 * If a candidate points at a directory, pick the first executable that exists
 * inside it; if it points at an executable, only accept it when present.
 */
function resolveExecutableFromCandidate(candidate: string, target: ShareTarget): string | null {
  const normalized = normalizeExecutablePath(candidate);
  if (/\.exe$/i.test(normalized)) {
    return existsSync(normalized) ? normalized : null;
  }
  for (const executable of SHARE_TARGET_EXECUTABLES[target]) {
    const fullPath = path.join(normalized, executable);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

async function readRegistryInstallPath(target: ShareTarget): Promise<string | null> {
  if (process.platform !== "win32") return null;
  for (const entry of SHARE_TARGET_REGISTRY_KEYS[target]) {
    const named = await queryRegistryValue(["query", entry.key, "/v", entry.value], entry.value);
    if (named) return named;
  }
  // App Paths keys resolve the executable itself and cover clients that never
  // wrote an InstallPath value.
  for (const executable of SHARE_TARGET_EXECUTABLES[target]) {
    for (const hive of ["HKCU", "HKLM"]) {
      const appPathKey = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`;
      const resolved = await queryRegistryValue(["query", appPathKey, "/ve"], null);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Detects which share targets are installed on this machine. */
export async function detectShareTargets(): Promise<ShareTargetStatus[]> {
  const results: ShareTargetStatus[] = [];
  for (const target of SHARE_TARGETS) {
    const registryPath = await readRegistryInstallPath(target);
    const existingPaths = getShareAppSearchPaths(target, process.env).filter((candidate) => existsSync(candidate));
    const plan = planShareLaunch(target, { registryPath, existingPaths });
    const appPath = plan.method === "app-path" && plan.value
      ? resolveExecutableFromCandidate(plan.value, target)
      : existingPaths[0] ?? null;
    results.push({
      target,
      label: SHARE_TARGET_LABELS[target],
      available: Boolean(appPath),
      launchMethod: appPath ? "app-path" : "protocol",
      appPath
    });
  }
  return results;
}

function launchShareApp(executablePath: string): boolean {
  try {
    const child = spawn(executablePath, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the composed share text to the system clipboard and brings the target
 * client to the foreground. No message is sent automatically: WeChat exposes no
 * personal-message API, so the user picks the conversation and pastes.
 */
export async function sendShareToTarget(request: ShareSendRequest): Promise<ShareSendResult> {
  const target = request.target;
  const label = SHARE_TARGET_LABELS[target] ?? target;
  const format = resolveShareFormat(target);
  const text = typeof request.text === "string" ? request.text : "";
  if (!text.trim()) {
    return {
      ok: false,
      target,
      format,
      copied: false,
      launched: false,
      launchMethod: "unavailable",
      message: "当前任务没有可分享的回答内容。"
    };
  }

  clipboard.writeText(text);

  let launchMethod: ShareLaunchMethod = "unavailable";
  let launched = false;
  const status = (await detectShareTargets()).find((item) => item.target === target);
  if (status?.appPath && launchShareApp(status.appPath)) {
    launchMethod = "app-path";
    launched = true;
  } else {
    try {
      await shell.openExternal(SHARE_TARGET_PROTOCOLS[target]);
      launchMethod = "protocol";
      launched = true;
    } catch {
      launchMethod = "unavailable";
      launched = false;
    }
  }

  return {
    ok: true,
    target,
    format,
    copied: true,
    launched,
    launchMethod,
    message: launched
      ? `已复制到剪贴板并唤起${label}，选择聊天窗口粘贴即可发送。`
      : `内容已复制到剪贴板，但未找到${label}客户端，请手动打开后粘贴。`
  };
}

/** Panel label per share channel, used for the in-app notice. */
export const SHARE_CHANNEL_LABELS: Record<ShareChannel, string> = {
  wechat: "微信",
  dingtalk: "钉钉",
  copyImage: "剪贴板",
  saveImage: "本地文件",
  copyMarkdown: "剪贴板"
};

/**
 * Deliver a rendered conversation image.
 *
 * The image and its markdown fallback are written to the clipboard together:
 * targets that accept images paste the picture, and anything that does not
 * still receives readable text. Chat clients are only brought forward, never
 * driven, because none of them expose a personal-message API.
 */
export async function sendShareImage(request: ShareImageRequest): Promise<ShareImageResult> {
  const channel = request.channel;
  const label = SHARE_CHANNEL_LABELS[channel] ?? channel;
  const markdown = typeof request.markdown === "string" ? request.markdown : "";
  const dataUrl = typeof request.image?.dataUrl === "string" ? request.image.dataUrl : "";

  if (channel === "copyMarkdown") {
    if (!markdown.trim()) {
      return failure(channel, "当前任务没有可分享的回答内容。");
    }
    clipboard.writeText(markdown);
    return {
      ok: true,
      channel,
      copied: true,
      launched: false,
      launchMethod: "unavailable",
      savedPath: null,
      cancelled: false,
      message: "已复制 Markdown 内容到剪贴板。"
    };
  }

  if (!dataUrl.startsWith("data:image/")) {
    return failure(channel, "分享图片生成失败，请重试。");
  }

  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) {
    return failure(channel, "分享图片生成失败，请重试。");
  }

  if (channel === "saveImage") {
    const fileName = request.fileName?.trim() || "codexh-对话.png";
    const result = await dialog.showSaveDialog({
      title: "保存分享图片",
      defaultPath: path.join(app.getPath("pictures"), fileName),
      filters: [{ name: "PNG 图片", extensions: ["png"] }]
    });
    if (result.canceled || !result.filePath) {
      return {
        ok: true,
        channel,
        copied: false,
        launched: false,
        launchMethod: "unavailable",
        savedPath: null,
        cancelled: true,
        message: "已取消保存。"
      };
    }
    try {
      await writeFile(result.filePath, image.toPNG());
    } catch (error) {
      return failure(channel, error instanceof Error ? error.message : "图片写入失败。");
    }
    return {
      ok: true,
      channel,
      copied: false,
      launched: false,
      launchMethod: "unavailable",
      savedPath: result.filePath,
      cancelled: false,
      message: `图片已保存到 ${result.filePath}`
    };
  }

  clipboard.write({ image, text: markdown });

  if (channel === "copyImage") {
    return {
      ok: true,
      channel,
      copied: true,
      launched: false,
      launchMethod: "unavailable",
      savedPath: null,
      cancelled: false,
      message: "对话长图已复制到剪贴板，粘贴即可发送。"
    };
  }

  const target = channel as ShareTarget;
  let launchMethod: ShareLaunchMethod = "unavailable";
  let launched = false;
  const status = (await detectShareTargets()).find((item) => item.target === target);
  if (status?.appPath && launchShareApp(status.appPath)) {
    launchMethod = "app-path";
    launched = true;
  } else {
    try {
      await shell.openExternal(SHARE_TARGET_PROTOCOLS[target]);
      launchMethod = "protocol";
      launched = true;
    } catch {
      launchMethod = "unavailable";
      launched = false;
    }
  }

  return {
    ok: true,
    channel,
    copied: true,
    launched,
    launchMethod,
    savedPath: null,
    cancelled: false,
    message: launched
      ? `对话长图已复制到剪贴板并唤起${label}，粘贴即可发送。`
      : `对话长图已复制到剪贴板，但未找到${label}客户端，请手动打开后粘贴。`
  };
}

function failure(channel: ShareChannel, message: string): ShareImageResult {
  return {
    ok: false,
    channel,
    copied: false,
    launched: false,
    launchMethod: "unavailable",
    savedPath: null,
    cancelled: false,
    message
  };
}
