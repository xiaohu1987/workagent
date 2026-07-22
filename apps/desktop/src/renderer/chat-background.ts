export type ChatBackgroundFit = "cover" | "contain";

export type ChatBackgroundSettings = {
  enabled: boolean;
  opacity: number;
  blur: number;
  fit: ChatBackgroundFit;
  zoom: number;
  positionX: number;
  positionY: number;
  fileName: string | null;
};

export const DEFAULT_CHAT_BACKGROUND_SETTINGS: ChatBackgroundSettings = {
  enabled: true,
  opacity: 24,
  blur: 8,
  fit: "cover",
  zoom: 115,
  positionX: 50,
  positionY: 50,
  fileName: null
};

const SETTINGS_KEY = "codexh.chat-background.settings";
const DATABASE_NAME = "codexh-appearance";
const DATABASE_VERSION = 1;
const ASSET_STORE = "assets";
const BACKGROUND_KEY = "chat-background";
const MAX_EXPORT_EDGE = 4096;

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
}

export function normalizeChatBackgroundSettings(value: unknown): ChatBackgroundSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_CHAT_BACKGROUND_SETTINGS };
  }

  const source = value as Partial<ChatBackgroundSettings>;
  return {
    enabled: source.enabled !== false,
    opacity: Math.round(clamp(source.opacity, 0, 100, DEFAULT_CHAT_BACKGROUND_SETTINGS.opacity)),
    blur: Math.round(clamp(source.blur, 0, 30, DEFAULT_CHAT_BACKGROUND_SETTINGS.blur)),
    fit: source.fit === "contain" ? "contain" : "cover",
    zoom: Math.round(clamp(source.zoom, 100, 180, DEFAULT_CHAT_BACKGROUND_SETTINGS.zoom)),
    positionX: Math.round(clamp(source.positionX, 0, 100, DEFAULT_CHAT_BACKGROUND_SETTINGS.positionX)),
    positionY: Math.round(clamp(source.positionY, 0, 100, DEFAULT_CHAT_BACKGROUND_SETTINGS.positionY)),
    fileName: typeof source.fileName === "string" && source.fileName.trim() ? source.fileName.trim() : null
  };
}

export function readChatBackgroundSettings(storage: Pick<Storage, "getItem"> = window.localStorage): ChatBackgroundSettings {
  try {
    const value = storage.getItem(SETTINGS_KEY);
    return value ? normalizeChatBackgroundSettings(JSON.parse(value)) : { ...DEFAULT_CHAT_BACKGROUND_SETTINGS };
  } catch {
    return { ...DEFAULT_CHAT_BACKGROUND_SETTINGS };
  }
}

export function writeChatBackgroundSettings(
  settings: ChatBackgroundSettings,
  storage: Pick<Storage, "setItem"> = window.localStorage
): void {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeChatBackgroundSettings(settings)));
  } catch {
    // A denied localStorage write must not interrupt the chat experience.
  }
}

function openAppearanceDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ASSET_STORE)) {
        request.result.createObjectStore(ASSET_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开背景图存储。"));
  });
}

async function withAssetStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openAppearanceDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(ASSET_STORE, mode);
      const request = operation(transaction.objectStore(ASSET_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("背景图存储操作失败。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("背景图存储操作已中止。"));
    });
  } finally {
    database.close();
  }
}

export function loadChatBackgroundBlob(): Promise<Blob | undefined> {
  return withAssetStore<Blob | undefined>("readonly", (store) => store.get(BACKGROUND_KEY));
}

export async function removeChatBackgroundBlob(): Promise<void> {
  await withAssetStore<undefined>("readwrite", (store) => store.delete(BACKGROUND_KEY));
}

export function getChatBackgroundTransform(settings: ChatBackgroundSettings): string {
  const travel = (settings.zoom - 100) / 2;
  const translateX = ((50 - settings.positionX) / 50) * travel;
  const translateY = ((50 - settings.positionY) / 50) * travel;
  return `translate3d(${translateX}%, ${translateY}%, 0) scale(${settings.zoom / 100})`;
}

function loadImage(sourceUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法读取，请尝试其他文件。"));
    image.src = sourceUrl;
  });
}

export async function renderChatBackgroundPng(
  sourceUrl: string,
  settings: ChatBackgroundSettings
): Promise<Blob> {
  const image = await loadImage(sourceUrl);
  const naturalWidth = Math.max(1, image.naturalWidth);
  const naturalHeight = Math.max(1, image.naturalHeight);
  const targetAspectRatio = 16 / 10;
  const sourceAspectRatio = naturalWidth / naturalHeight;
  const width = sourceAspectRatio >= targetAspectRatio
    ? Math.max(1, Math.round(Math.min(naturalHeight, MAX_EXPORT_EDGE / targetAspectRatio) * targetAspectRatio))
    : Math.max(1, Math.min(naturalWidth, MAX_EXPORT_EDGE));
  const height = Math.max(1, Math.round(width / targetAspectRatio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境不支持图片处理。");

  const fitScale = settings.fit === "contain"
    ? Math.min(width / naturalWidth, height / naturalHeight)
    : Math.max(width / naturalWidth, height / naturalHeight);
  const imageScale = fitScale * (settings.zoom / 100);
  const drawnWidth = naturalWidth * imageScale;
  const drawnHeight = naturalHeight * imageScale;
  const offsetX = (width - drawnWidth) * (settings.positionX / 100);
  const offsetY = (height - drawnHeight) * (settings.positionY / 100);
  const blur = settings.blur * Math.min(1, width / naturalWidth, height / naturalHeight);
  const bleed = Math.ceil(blur * 2.5);
  context.save();
  context.globalAlpha = settings.opacity / 100;
  context.filter = blur > 0 ? `blur(${blur}px)` : "none";
  context.drawImage(
    image,
    offsetX - bleed,
    offsetY - bleed,
    drawnWidth + bleed * 2,
    drawnHeight + bleed * 2
  );
  context.restore();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("PNG 生成失败。")),
      "image/png"
    );
  });
}
