import { useSyncExternalStore } from "react";
import type { ApiCardConfig } from "./cards/api-card";

export interface ApiCardFavorite {
  id: string;
  /** 收藏名称,默认取卡片标题 */
  name: string;
  config: ApiCardConfig;
  createdAt: number;
}

export interface ApiCardFavoriteNotice {
  action: "added" | "removed";
  name: string;
}

export const API_CARD_FAVORITES_STORAGE_KEY = "codexh.api-card-favorites";
const API_CARD_FAVORITES_LIMIT = 200;
const FAVORITE_NOTICE_EVENT = "codexh:api-card-favorite-notice";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

interface ApiCardFavoritesBridge {
  loadApiCardFavorites: () => Promise<unknown[]>;
  saveApiCardFavorites: (favorites: unknown[]) => Promise<void>;
}

/** 桌面端走主进程 JSON 文件持久化;测试等无 IPC 环境回退 localStorage */
function getBridge(): ApiCardFavoritesBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as { codexh?: Partial<ApiCardFavoritesBridge> }).codexh;
  return typeof bridge?.loadApiCardFavorites === "function" && typeof bridge?.saveApiCardFavorites === "function"
    ? bridge as ApiCardFavoritesBridge
    : null;
}

function getLocalStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 收藏去重键:同一接口配置(method+url+完整结构)只收藏一次 */
export function getApiCardFavoriteKey(config: ApiCardConfig): string {
  return JSON.stringify(config);
}

export function filterApiCardFavorites(
  favorites: ApiCardFavorite[],
  query: string
): ApiCardFavorite[] {
  const keyword = query.trim().toLocaleLowerCase();
  if (!keyword) return favorites;
  return favorites.filter((favorite) => {
    return (
      favorite.name.toLocaleLowerCase().includes(keyword) ||
      favorite.config.title.toLocaleLowerCase().includes(keyword) ||
      favorite.config.url.toLocaleLowerCase().includes(keyword)
    );
  });
}

/** 序列化为聊天中可渲染的 ```api-card 围栏块 */
export function serializeApiCardFavorite(favorite: ApiCardFavorite): string {
  return ["```api-card", JSON.stringify(favorite.config, null, 2), "```"].join("\n");
}

function sanitizeFavorite(raw: unknown): ApiCardFavorite | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.name !== "string") return null;
  if (!record.config || typeof record.config !== "object") return null;
  const config = record.config as Record<string, unknown>;
  if (typeof config.title !== "string" || typeof config.url !== "string") return null;
  if (typeof config.method !== "string" || !Array.isArray(config.fields)) return null;
  return {
    id: record.id,
    name: record.name,
    config: config as unknown as ApiCardConfig,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now()
  };
}

function sanitizeFavoriteList(raw: unknown): ApiCardFavorite[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeFavorite)
    .filter((item): item is ApiCardFavorite => item !== null)
    .slice(0, API_CARD_FAVORITES_LIMIT);
}

function readLocalFavorites(): ApiCardFavorite[] {
  const storage = getLocalStorage();
  if (!storage) return [];
  try {
    return sanitizeFavoriteList(JSON.parse(storage.getItem(API_CARD_FAVORITES_STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function writeLocalFavorites(next: ApiCardFavorite[]): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(API_CARD_FAVORITES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 忽略配额/隐私模式写入失败
  }
}

let favoritesCache: ApiCardFavorite[] | null = null;
let hydrationStarted = false;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function hydrateFavorites(): void {
  if (hydrationStarted) return;
  hydrationStarted = true;
  const bridge = getBridge();
  if (!bridge) {
    favoritesCache = readLocalFavorites();
    return;
  }
  void bridge.loadApiCardFavorites()
    .then((raw) => {
      if (favoritesCache !== null) {
        // 水合完成前已有本地修改,以内存为准并回写,避免被旧数据覆盖
        void bridge.saveApiCardFavorites(favoritesCache).catch(() => undefined);
        return;
      }
      favoritesCache = sanitizeFavoriteList(raw);
      notifyListeners();
    })
    .catch(() => {
      if (favoritesCache === null) favoritesCache = readLocalFavorites();
    });
}

function getFavorites(): ApiCardFavorite[] {
  if (favoritesCache === null) {
    hydrateFavorites();
    return favoritesCache ?? EMPTY_FAVORITES;
  }
  return favoritesCache;
}

function persistFavorites(next: ApiCardFavorite[]): void {
  favoritesCache = next;
  const bridge = getBridge();
  if (bridge) {
    void bridge.saveApiCardFavorites(next).catch(() => writeLocalFavorites(next));
  } else {
    writeLocalFavorites(next);
  }
  notifyListeners();
}

function emitFavoriteNotice(notice: ApiCardFavoriteNotice): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function" || typeof CustomEvent !== "function") {
    return;
  }
  window.dispatchEvent(new CustomEvent<ApiCardFavoriteNotice>(FAVORITE_NOTICE_EVENT, { detail: notice }));
}

export function subscribeApiCardFavoriteNotices(listener: (notice: ApiCardFavoriteNotice) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ApiCardFavoriteNotice>).detail);
  window.addEventListener(FAVORITE_NOTICE_EVENT, handler);
  return () => window.removeEventListener(FAVORITE_NOTICE_EVENT, handler);
}

/** 仅供测试:清空内存缓存并重新从存储读取 */
export function resetApiCardFavoritesCacheForTest(): void {
  favoritesCache = null;
  hydrationStarted = false;
}

export function subscribeApiCardFavorites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isApiCardFavorited(config: ApiCardConfig): boolean {
  const key = getApiCardFavoriteKey(config);
  return getFavorites().some((favorite) => getApiCardFavoriteKey(favorite.config) === key);
}

/** 收藏接口配置;已收藏同配置时返回既有收藏 */
export function addApiCardFavorite(config: ApiCardConfig, name?: string): ApiCardFavorite {
  const key = getApiCardFavoriteKey(config);
  const existing = getFavorites().find((favorite) => getApiCardFavoriteKey(favorite.config) === key);
  if (existing) return existing;
  const favorite: ApiCardFavorite = {
    id: `api-fav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name?.trim() || config.title,
    config,
    createdAt: Date.now()
  };
  persistFavorites([favorite, ...getFavorites()].slice(0, API_CARD_FAVORITES_LIMIT));
  emitFavoriteNotice({ action: "added", name: favorite.name });
  return favorite;
}

export function removeApiCardFavorite(id: string): void {
  const removed = getFavorites().find((favorite) => favorite.id === id);
  if (!removed) return;
  persistFavorites(getFavorites().filter((favorite) => favorite.id !== id));
  emitFavoriteNotice({ action: "removed", name: removed.name });
}

export function removeApiCardFavoriteByConfig(config: ApiCardConfig): void {
  const key = getApiCardFavoriteKey(config);
  const removed = getFavorites().find((favorite) => getApiCardFavoriteKey(favorite.config) === key);
  if (!removed) return;
  persistFavorites(getFavorites().filter((favorite) => getApiCardFavoriteKey(favorite.config) !== key));
  emitFavoriteNotice({ action: "removed", name: removed.name });
}

export function renameApiCardFavorite(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  persistFavorites(
    getFavorites().map((favorite) => (favorite.id === id ? { ...favorite, name: trimmed } : favorite))
  );
}

const EMPTY_FAVORITES: ApiCardFavorite[] = [];

export function useApiCardFavorites(): ApiCardFavorite[] {
  return useSyncExternalStore(
    subscribeApiCardFavorites,
    getFavorites,
    () => EMPTY_FAVORITES
  );
}

export function useIsApiCardFavorited(config: ApiCardConfig | null): boolean {
  const favorites = useApiCardFavorites();
  if (!config) return false;
  const key = getApiCardFavoriteKey(config);
  return favorites.some((favorite) => getApiCardFavoriteKey(favorite.config) === key);
}
