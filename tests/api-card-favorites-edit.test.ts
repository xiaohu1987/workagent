import { beforeEach, describe, expect, it } from "vitest";
import {
  addApiCardFavorite,
  API_CARD_FAVORITES_STORAGE_KEY,
  resetApiCardFavoritesCacheForTest,
  updateApiCardFavoriteConfig
} from "../apps/desktop/src/renderer/api-card-favorites";
import {
  createApiCardEditDraft,
  resolveApiCardEditDraft
} from "../apps/desktop/src/renderer/workspace/api-favorites-card-edit";
import type { ApiCardConfig } from "../apps/desktop/src/renderer/cards/api-card";

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

type PersistedFavorite = {
  id: string;
  name: string;
  createdAt: number;
  config: ApiCardConfig;
};

function readPersisted(): PersistedFavorite[] {
  return JSON.parse(
    localStorageMock.getItem(API_CARD_FAVORITES_STORAGE_KEY) ?? "[]"
  ) as PersistedFavorite[];
}

describe("收藏卡片编辑态", () => {
  beforeEach(() => {
    localStorageMock.clear();
    resetApiCardFavoritesCacheForTest();
  });

  it("进入编辑态时回显名称、URL、入参 JSON 与授权开关", () => {
    const favorite = addApiCardFavorite(
      makeConfig({ auth: { type: "bearer" } }),
      "我的接口"
    );
    const draft = createApiCardEditDraft(favorite);
    expect(draft.id).toBe(favorite.id);
    expect(draft.name).toBe("我的接口");
    expect(draft.url).toBe("https://api.example.com/v1/users");
    expect(draft.authEnabled).toBe(true);
    expect(JSON.parse(draft.fieldsText)).toEqual(favorite.config.fields);
  });

  it("保存时同时更新名称、URL 与入参", () => {
    const favorite = addApiCardFavorite(makeConfig());
    const resolved = resolveApiCardEditDraft(favorite, {
      id: favorite.id,
      name: "  改名后  ",
      url: "  https://api.example.com/v2/users  ",
      fieldsText: JSON.stringify([{ name: "id", label: "编号", type: "text" }]),
      authEnabled: false
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.name).toBe("改名后");
    expect(resolved.config.url).toBe("https://api.example.com/v2/users");
    expect(resolved.config.fields).toHaveLength(1);
    expect(resolved.config.fields[0]?.name).toBe("id");
  });

  it("授权开关只切换 auth 有无，保留原有授权类型", () => {
    const favorite = addApiCardFavorite(makeConfig({ auth: { type: "apiKey", name: "X-Token" } }));
    const withoutAuth = resolveApiCardEditDraft(favorite, {
      id: favorite.id,
      name: favorite.name,
      url: favorite.config.url,
      fieldsText: "[]",
      authEnabled: false
    });
    expect(withoutAuth.ok).toBe(true);
    if (withoutAuth.ok) expect(withoutAuth.config.auth).toBeUndefined();

    const withAuth = resolveApiCardEditDraft(favorite, {
      id: favorite.id,
      name: favorite.name,
      url: favorite.config.url,
      fieldsText: "[]",
      authEnabled: true
    });
    expect(withAuth.ok).toBe(true);
    if (withAuth.ok) expect(withAuth.config.auth).toEqual({ type: "apiKey", name: "X-Token" });
  });

  it("入参 JSON 非法时报错且不写入配置", () => {
    const favorite = addApiCardFavorite(makeConfig());
    const invalidJson = resolveApiCardEditDraft(favorite, {
      id: favorite.id,
      name: favorite.name,
      url: favorite.config.url,
      fieldsText: "[{",
      authEnabled: false
    });
    expect(invalidJson.ok).toBe(false);
    if (!invalidJson.ok) expect(invalidJson.error).toContain("入参 JSON 格式无效");

    const notArray = resolveApiCardEditDraft(favorite, {
      id: favorite.id,
      name: favorite.name,
      url: favorite.config.url,
      fieldsText: '{"name":"id"}',
      authEnabled: false
    });
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.error).toContain("字段数组");
  });

  it("URL 不合法时沿用卡片配置校验的报错", () => {
    const favorite = addApiCardFavorite(makeConfig());
    const resolved = resolveApiCardEditDraft(favorite, {
      id: favorite.id,
      name: favorite.name,
      url: "ftp://api.example.com/v1",
      fieldsText: "[]",
      authEnabled: false
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("http://");
  });

  it("名称留空时回退为原名称", () => {
    const favorite = addApiCardFavorite(makeConfig(), "原名称");
    const resolved = resolveApiCardEditDraft(favorite, {
      id: favorite.id,
      name: "   ",
      url: favorite.config.url,
      fieldsText: "[]",
      authEnabled: false
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.name).toBe("原名称");
  });

  it("写回配置时保留收藏 id、名称与收藏时间", () => {
    const favorite = addApiCardFavorite(makeConfig(), "保留名称");
    const nextConfig = makeConfig({ url: "https://api.example.com/v3/users" });
    updateApiCardFavoriteConfig(favorite.id, nextConfig);

    const persisted = readPersisted();
    const updated = persisted.find((item) => item.id === favorite.id);
    expect(updated).toBeTruthy();
    expect(updated?.name).toBe("保留名称");
    expect(updated?.createdAt).toBe(favorite.createdAt);
    expect(updated?.config.url).toBe("https://api.example.com/v3/users");
    expect(persisted).toHaveLength(1);
  });

  it("对不存在的收藏写回配置时不做任何改动", () => {
    addApiCardFavorite(makeConfig());
    const before = readPersisted();
    updateApiCardFavoriteConfig("not-exist", makeConfig({ url: "https://api.example.com/x" }));
    expect(readPersisted()).toEqual(before);
  });
});
