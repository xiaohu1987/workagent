import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  DEFAULT_CHAT_BACKGROUND_SURFACES,
  getChatBackgroundActiveIndex,
  getChatBackgroundSurfaceStyleVars,
  isChatBackgroundRotationActive,
  loadChatBackgroundBlob,
  normalizeChatBackgroundSettings,
  readChatBackgroundSettings,
  removeChatBackgroundBlob,
  writeChatBackgroundSettings,
  type ChatBackgroundSettings,
  type ChatBackgroundSurfaceKey,
  type ChatBackgroundSurfaces
} from "../chat-background";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

export type ChatBackgroundImage = {
  id: string;
  fileName: string;
  mimeType: string;
  bytes: ArrayBuffer;
  url: string;
};

type Options = {
  appShellRef: RefObject<HTMLDivElement | null>;
  showNotice: Notice;
};

const BACKGROUND_LOAD_ATTEMPTS = 3;

function waitForBackgroundStorage(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export function useChatBackground({ appShellRef, showNotice }: Options) {
  const [settings, setSettings] = useState<ChatBackgroundSettings>(() => readChatBackgroundSettings());
  const [images, setImages] = useState<ChatBackgroundImage[]>([]);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [rotationEpoch, setRotationEpoch] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hydratedRef = useRef(false);
  const urlsRef = useRef<Set<string>>(new Set());
  const imagesRef = useRef<ChatBackgroundImage[]>([]);
  const dragRef = useRef<null | {
    pointerId: number;
    startX: number;
    startY: number;
    positionX: number;
    positionY: number;
    width: number;
    height: number;
  }>(null);
  const activeImage = images[activeImageIndex] ?? null;
  const imageUrl = activeImage?.url ?? null;

  useEffect(() => {
    let active = true;
    void (async () => {
      for (let attempt = 0; attempt < BACKGROUND_LOAD_ATTEMPTS; attempt += 1) {
        try {
          const persisted = await window.codexh.getApplicationBackgrounds();
          if (persisted) {
            if (!active) return;
            const restoredSettings = normalizeChatBackgroundSettings(persisted.settings);
            setSettings(normalizeChatBackgroundSettings({
              ...restoredSettings,
              fileName: restoredSettings.fileName ?? persisted.items[0]?.fileName ?? null
            }));
            const restoredImages = persisted.items.map((item) => {
              const url = URL.createObjectURL(new Blob([item.bytes], { type: item.mimeType }));
              urlsRef.current.add(url);
              return { ...item, url };
            });
            setImages(restoredImages);
            setActiveImageIndex(getChatBackgroundActiveIndex(restoredSettings, restoredImages));
            return;
          }

          const legacyBlob = await loadChatBackgroundBlob();
          if (!legacyBlob) return;
          const legacySettings = readChatBackgroundSettings();
          const bytes = await legacyBlob.arrayBuffer();
          const id = globalThis.crypto.randomUUID();
          await window.codexh.saveApplicationBackgrounds({
            items: [{ id, bytes, mimeType: legacyBlob.type, fileName: legacySettings.fileName ?? "background" }],
            settings: legacySettings
          });
          await removeChatBackgroundBlob();
          if (!active) return;
          const url = URL.createObjectURL(legacyBlob);
          urlsRef.current.add(url);
          setImages([{ id, bytes, mimeType: legacyBlob.type, fileName: legacySettings.fileName ?? "background", url }]);
          setActiveImageIndex(0);
          return;
        } catch (error) {
          if (attempt === BACKGROUND_LOAD_ATTEMPTS - 1) throw error;
          await waitForBackgroundStorage(200 * (attempt + 1));
          if (!active) return;
        }
      }
    })()
      .catch(() => {
        if (active) {
          showNotice("应用背景加载失败", { message: "本地背景图存储暂时不可用。", tone: "warning" });
        }
      })
      .finally(() => {
        hydratedRef.current = true;
      });
    return () => {
      active = false;
    };
  }, [showNotice]);

  useEffect(() => {
    writeChatBackgroundSettings(settings);
    if (!hydratedRef.current) return;
    const timeout = window.setTimeout(() => {
      void window.codexh.saveApplicationBackgroundSettings(settings).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [settings]);

  useEffect(() => {
    const root = document.documentElement;
    const active = Boolean(imageUrl && settings.enabled);
    const vars = getChatBackgroundSurfaceStyleVars(settings.surfaces);
    if (active) {
      for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
      return () => {
        for (const key of Object.keys(vars)) root.style.removeProperty(key);
      };
    }
    for (const key of Object.keys(vars)) root.style.removeProperty(key);
    return undefined;
  }, [imageUrl, settings.enabled, settings.surfaces]);

  useEffect(() => {
    const shell = appShellRef.current;
    if (!shell) return;
    const reset = () => {
      shell.style.setProperty("--app-background-parallax-x", "0px");
      shell.style.setProperty("--app-background-parallax-y", "0px");
      shell.style.setProperty("--app-background-parallax-back-x", "0px");
      shell.style.setProperty("--app-background-parallax-back-y", "0px");
      shell.style.setProperty("--app-background-parallax-front-x", "0px");
      shell.style.setProperty("--app-background-parallax-front-y", "0px");
    };
    if (!imageUrl || !settings.enabled || !settings.parallaxEnabled) {
      reset();
      return;
    }

    let animationFrame = 0;
    let targetX = 0;
    let targetY = 0;
    const paint = () => {
      animationFrame = 0;
      shell.style.setProperty("--app-background-parallax-x", `${targetX.toFixed(2)}px`);
      shell.style.setProperty("--app-background-parallax-y", `${targetY.toFixed(2)}px`);
      shell.style.setProperty("--app-background-parallax-back-x", `${(targetX * 0.42).toFixed(2)}px`);
      shell.style.setProperty("--app-background-parallax-back-y", `${(targetY * 0.42).toFixed(2)}px`);
      shell.style.setProperty("--app-background-parallax-front-x", `${(targetX * 1.5).toFixed(2)}px`);
      shell.style.setProperty("--app-background-parallax-front-y", `${(targetY * 1.5).toFixed(2)}px`);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (document.hidden) return;
      targetX = ((event.clientX / Math.max(1, window.innerWidth)) - 0.5) * 14;
      targetY = ((event.clientY / Math.max(1, window.innerHeight)) - 0.5) * 14;
      if (!animationFrame) animationFrame = window.requestAnimationFrame(paint);
    };
    const handlePointerLeave = () => {
      targetX = 0;
      targetY = 0;
      if (!animationFrame) animationFrame = window.requestAnimationFrame(paint);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) handlePointerLeave();
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("blur", handlePointerLeave);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("blur", handlePointerLeave);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      reset();
    };
  }, [appShellRef, imageUrl, settings.enabled, settings.parallaxEnabled]);

  useEffect(() => () => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  }, []);

  useEffect(() => {
    imagesRef.current = images;
    setActiveImageIndex((current) => Math.min(current, Math.max(0, images.length - 1)));
  }, [images]);

  useEffect(() => {
    if (!isChatBackgroundRotationActive(settings, images.length)) return;
    const interval = window.setInterval(() => {
      setActiveImageIndex((current) => (current + 1) % images.length);
    }, settings.rotationIntervalSeconds * 1_000);
    return () => window.clearInterval(interval);
  }, [images.length, rotationEpoch, settings]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) setRotationEpoch((current) => current + 1);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  function updateSettings(patch: Partial<Omit<ChatBackgroundSettings, "surfaces">> & { surfaces?: Partial<ChatBackgroundSurfaces> }) {
    setSettings((current) => normalizeChatBackgroundSettings({
      ...current,
      ...patch,
      surfaces: patch.surfaces ? { ...current.surfaces, ...patch.surfaces } : current.surfaces
    }));
  }

  function updateSurface(key: ChatBackgroundSurfaceKey, value: number) {
    updateSettings({ surfaces: { [key]: value } });
  }

  function selectImage(index: number) {
    const image = imagesRef.current[index];
    if (!image) return;
    setActiveImageIndex(index);
    updateSettings({ fileName: image.fileName });
  }

  function beginDrag(event: ReactPointerEvent<HTMLImageElement>) {
    if (!imageUrl || event.button !== 0) return;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      positionX: settings.positionX,
      positionY: settings.positionY,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height)
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  }

  function moveDrag(event: ReactPointerEvent<HTMLImageElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateSettings({
      positionX: drag.positionX - ((event.clientX - drag.startX) / drag.width) * 100,
      positionY: drag.positionY - ((event.clientY - drag.startY) / drag.height) * 100
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLImageElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDragging(false);
  }

  async function importImage(file: File) {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      showNotice("请选择图片文件", { message: "支持 PNG、JPEG、WebP、GIF 等常见格式。", tone: "warning" });
      return;
    }
    if (file.size > 40 * 1024 * 1024) {
      showNotice("图片过大", { message: "请选择小于 40 MB 的图片。", tone: "warning" });
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    try {
      const probe = new Image();
      probe.src = nextUrl;
      await probe.decode();
    } catch {
      URL.revokeObjectURL(nextUrl);
      showNotice("图片读取失败", { message: "文件格式无法解码，请更换一张 PNG、JPEG 或 WebP 图片。", tone: "warning" });
      return;
    }

    try {
      const nextSettings = normalizeChatBackgroundSettings({ ...settings, enabled: settings.enabled, fileName: file.name });
      const bytes = await file.arrayBuffer();
      const nextImage: ChatBackgroundImage = {
        id: globalThis.crypto.randomUUID(), bytes, mimeType: file.type, fileName: file.name, url: nextUrl
      };
      const nextImages = [...imagesRef.current, nextImage];
      await window.codexh.saveApplicationBackgrounds({
        items: nextImages.map(({ id, bytes: imageBytes, mimeType, fileName }) => ({ id, bytes: imageBytes, mimeType, fileName })),
        settings: nextSettings
      });
      urlsRef.current.add(nextUrl);
      imagesRef.current = nextImages;
      setImages(nextImages);
      setActiveImageIndex(nextImages.length - 1);
      setSettings(nextSettings);
      showNotice("应用背景已更新", { message: "位置、模糊度和透明度可继续实时调整。", tone: "success" });
    } catch (error) {
      URL.revokeObjectURL(nextUrl);
      showNotice("图片保存失败", { message: error instanceof Error ? error.message : String(error), tone: "warning" });
    }
  }

  async function importFiles(files: FileList | File[]) {
    const selectedFiles = Array.from(files);
    if (imagesRef.current.length + selectedFiles.length > 50) {
      showNotice("图片数量过多", { message: "应用背景最多支持 50 张图片。", tone: "warning" });
      return;
    }
    for (const file of selectedFiles) await importImage(file);
  }

  async function removeImage(id: string) {
    const currentImages = imagesRef.current;
    const removed = currentImages.find((image) => image.id === id);
    const nextImages = currentImages.filter((image) => image.id !== id);
    try {
      if (nextImages.length === 0) {
        await window.codexh.clearApplicationBackground();
        updateSettings({ fileName: null });
      } else {
        await window.codexh.saveApplicationBackgrounds({
          items: nextImages.map(({ id: imageId, bytes, mimeType, fileName }) => ({ id: imageId, bytes, mimeType, fileName })),
          settings
        });
      }
      if (removed) {
        URL.revokeObjectURL(removed.url);
        urlsRef.current.delete(removed.url);
      }
      imagesRef.current = nextImages;
      setImages(nextImages);
      showNotice(nextImages.length ? "背景图片已删除" : "应用背景已清除", { tone: "success" });
    } catch (error) {
      showNotice("删除背景图片失败", { message: error instanceof Error ? error.message : String(error), tone: "warning" });
    }
  }

  async function moveImage(sourceId: string, targetId: string) {
    const currentImages = imagesRef.current;
    const from = currentImages.findIndex((image) => image.id === sourceId);
    const to = currentImages.findIndex((image) => image.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const nextImages = [...currentImages];
    const [moved] = nextImages.splice(from, 1);
    nextImages.splice(to, 0, moved);
    try {
      await window.codexh.saveApplicationBackgrounds({
        items: nextImages.map(({ id, bytes, mimeType, fileName }) => ({ id, bytes, mimeType, fileName })),
        settings
      });
      imagesRef.current = nextImages;
      setImages(nextImages);
    } catch (error) {
      showNotice("背景排序保存失败", { message: error instanceof Error ? error.message : String(error), tone: "warning" });
    }
  }

  async function clear() {
    try {
      await window.codexh.clearApplicationBackground();
      for (const image of imagesRef.current) {
        URL.revokeObjectURL(image.url);
        urlsRef.current.delete(image.url);
      }
      imagesRef.current = [];
      setImages([]);
      updateSettings({ fileName: null });
      showNotice("应用背景已清除", { tone: "success" });
    } catch (error) {
      showNotice("清除背景失败", { message: error instanceof Error ? error.message : String(error), tone: "warning" });
    }
  }

  function resetSurfaces() {
    updateSettings({ surfaces: { ...DEFAULT_CHAT_BACKGROUND_SURFACES } });
    showNotice("模块不透明度已重置", { tone: "success" });
  }

  return {
    images,
    activeImageIndex,
    setActiveImageIndex: selectImage,
    settings,
    inputRef,
    imageUrl,
    isDragging,
    importFiles,
    moveImage,
    removeImage,
    updateSettings,
    updateSurface,
    beginDrag,
    moveDrag,
    endDrag,
    resetSurfaces,
    clear
  };
}
