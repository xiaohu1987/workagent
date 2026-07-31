import { beforeEach, describe, expect, it } from "vitest";
import {
  addApiCardFavorite,
  filterApiCardFavorites,
  getApiCardFavoriteKey,
  isApiCardFavorited,
  removeApiCardFavorite,
  removeApiCardFavoriteByConfig,
  renameApiCardFavorite,
  resetApiCardFavoritesCacheForTest,
  serializeApiCardFavorite,
  API_CARD_FAVORITES_STORAGE_KEY
} from "../apps/desktop/src/renderer/api-card-favorites";
import type { ApiCardConfig } from "../apps/desktop/src/renderer/api-card";

function makeConfig(overrides: Partial<ApiCardConfig> = {}): ApiCardConfig {
  return {
    title: "查询用户",
    method: "POST",
    url: "https://api.example.com/v1/users",
    fields: [{ name: "name", label: "姓名", type: "text", required: true }],
    ...overrides
  };
}

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    }
  };
})();

Object.defineProperty(globalThis, "window", {
  value: { localStorage: localStorageMock },
  writable: true
});

describe("api-card-favorites", () => {
  beforeEach(() => {
    localStorageMock.clear();
    resetApiCardFavoritesCacheForTest();
  });

  it("adds and persists a favorite to localStorage", () => {
    const config = makeConfig();
    const favorite = addApiCardFavorite(config);
    expect(favorite.name).toBe("查询用户");
    expect(isApiCardFavorited(config)).toBe(true);
    const raw = localStorageMock.getItem(API_CARD_FAVORITES_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw ?? "[]") as Array<{ id: string }>;
    expect(persisted.some((item) => item.id === favorite.id)).toBe(true);
  });

  it("dedupes favorites with identical config", () => {
    const config = makeConfig();
    const first = addApiCardFavorite(config);
    const second = addApiCardFavorite({ ...config });
    expect(second.id).toBe(first.id);
  });

  it("uses custom name when provided", () => {
    const favorite = addApiCardFavorite(makeConfig(), "  我的接口  ");
    expect(favorite.name).toBe("我的接口");
  });

  it("removes favorite by id and by config", () => {
    const configA = makeConfig();
    const configB = makeConfig({ title: "删除用户", url: "https://api.example.com/v1/del" });
    const favA = addApiCardFavorite(configA);
    addApiCardFavorite(configB);
    removeApiCardFavorite(favA.id);
    expect(isApiCardFavorited(configA)).toBe(false);
    expect(isApiCardFavorited(configB)).toBe(true);
    removeApiCardFavoriteByConfig(configB);
    expect(isApiCardFavorited(configB)).toBe(false);
  });

  it("renames a favorite", () => {
    const favorite = addApiCardFavorite(makeConfig());
    renameApiCardFavorite(favorite.id, "  新名字 ");
    const raw = JSON.parse(localStorageMock.getItem(API_CARD_FAVORITES_STORAGE_KEY) ?? "[]") as Array<{ id: string; name: string }>;
    expect(raw.find((item) => item.id === favorite.id)?.name).toBe("新名字");
  });

  it("ignores empty rename", () => {
    const favorite = addApiCardFavorite(makeConfig());
    renameApiCardFavorite(favorite.id, "   ");
    const raw = JSON.parse(localStorageMock.getItem(API_CARD_FAVORITES_STORAGE_KEY) ?? "[]") as Array<{ id: string; name: string }>;
    expect(raw.find((item) => item.id === favorite.id)?.name).toBe("查询用户");
  });

  it("filters favorites by name and url, case-insensitive", () => {
    const list = [
      { ...addApiCardFavorite(makeConfig()), config: makeConfig() },
      { ...addApiCardFavorite(makeConfig({ title: "订单列表", url: "https://api.example.com/orders" })), config: makeConfig({ title: "订单列表", url: "https://api.example.com/orders" }) }
    ];
    expect(filterApiCardFavorites(list, "")).toHaveLength(2);
    expect(filterApiCardFavorites(list, "查询")).toHaveLength(1);
    expect(filterApiCardFavorites(list, "ORDERS")).toHaveLength(1);
    expect(filterApiCardFavorites(list, "api.example.com")).toHaveLength(2);
    expect(filterApiCardFavorites(list, "不存在")).toHaveLength(0);
  });

  it("serializes a favorite into an api-card fence block", () => {
    const config = makeConfig();
    const favorite = addApiCardFavorite(config, "块测试");
    const block = serializeApiCardFavorite(favorite);
    expect(block.startsWith("```api-card\n")).toBe(true);
    expect(block.endsWith("\n```")).toBe(true);
    const json = block.slice("```api-card\n".length, -"\n```".length);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(config)));
  });

  it("produces stable dedupe keys regardless of object identity", () => {
    const a = makeConfig();
    const b = JSON.parse(JSON.stringify(a)) as ApiCardConfig;
    expect(getApiCardFavoriteKey(a)).toBe(getApiCardFavoriteKey(b));
  });
});
