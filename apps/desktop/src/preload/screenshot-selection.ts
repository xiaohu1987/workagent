import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("screenshotSelection", {
  onInit: (listener: (payload: { dataUrl: string; width: number; height: number }) => void) => {
    const wrapped = (_event: unknown, payload: { dataUrl: string; width: number; height: number }) => listener(payload);
    ipcRenderer.on("screenshot-selection:init", wrapped);
    return () => ipcRenderer.removeListener("screenshot-selection:init", wrapped);
  },
  complete: (payload: {
    action: "attach" | "copy" | "save";
    rect: { x: number; y: number; width: number; height: number };
  }) => ipcRenderer.invoke("screenshot-selection:complete", payload),
  cancel: () => ipcRenderer.invoke("screenshot-selection:cancel")
});
