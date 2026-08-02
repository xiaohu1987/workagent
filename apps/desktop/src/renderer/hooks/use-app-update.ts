import { useEffect, useState } from "react";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;
type UpdateState = Awaited<ReturnType<typeof window.codexh.checkForUpdates>>;

export type UpdateConfirmDialog = {
  kind: "download" | "install";
  title: string;
  message: string;
  details: string[];
};

export function useAppUpdate(showNotice: Notice) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<UpdateConfirmDialog | null>(null);

  useEffect(() => {
    void window.codexh.getUpdateState().then(setState).catch(() => undefined);
    return window.codexh.onUpdateState(setState);
  }, []);

  async function check() {
    try {
      setState(await window.codexh.checkForUpdates());
    } catch (error) {
      showNotice("检查更新失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function download() {
    if (!state) return;
    const needsConfirm = state.insecureTransport === true || state.missingSha256 === true;
    if (needsConfirm) {
      const details = [
        state.insecureTransport ? "更新源使用 HTTP，可能被篡改" : null,
        state.missingSha256 ? "更新清单未提供 sha256，无法校验安装包完整性" : null
      ].filter((entry): entry is string => Boolean(entry));
      setConfirmDialog({
        kind: "download",
        title: "确认下载更新",
        message: "此更新无法完全验证其来源或完整性，是否仍要继续下载？",
        details
      });
      return;
    }
    await proceedDownload(false);
  }

  async function proceedDownload(confirmInsecureHttp: boolean) {
    try {
      setConfirmDialog(null);
      setState(await window.codexh.downloadUpdate({ confirmInsecureHttp }));
    } catch (error) {
      showNotice("下载更新失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  function install() {
    setConfirmDialog({
      kind: "install",
      title: "确认安装更新",
      message: "安装更新会关闭 CodeXH 并覆盖当前版本，是否继续？",
      details: ["本地聊天、项目、知识库和日志会保留。"]
    });
  }

  async function proceedInstall() {
    try {
      setConfirmDialog(null);
      await window.codexh.installUpdate();
    } catch (error) {
      showNotice("暂时无法安装更新", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function confirm() {
    if (!confirmDialog) return;
    if (confirmDialog.kind === "download") {
      await proceedDownload(true);
      return;
    }
    await proceedInstall();
  }

  return {
    state,
    confirmDialog,
    setConfirmDialog,
    check,
    download,
    install,
    confirm
  };
}
