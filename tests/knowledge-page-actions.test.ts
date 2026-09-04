import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { KnowledgeBaseSummary } from "@shared-types";
import { isDatabaseManagedKnowledgeBase, KnowledgePage } from "../apps/desktop/src/renderer/settings/pages/knowledge/knowledge-page";

function createBase(overrides: Partial<KnowledgeBaseSummary> = {}): KnowledgeBaseSummary {
  return {
    id: "kb-1",
    scope: "global",
    projectId: null,
    displayName: "随手记",
    bundleRoot: "C:\\Users\\demo\\.codexh\\knowledge\\global\\bundles\\quick-notes",
    okfVersion: "0.1",
    status: "ready",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    documentCount: 8,
    chunkCount: 64,
    indexedBytes: 16_600,
    ...overrides
  };
}

function renderPage(knowledgeBases: KnowledgeBaseSummary[]): string {
  return renderToStaticMarkup(createElement(KnowledgePage, {
    knowledgeSources: [],
    knowledgeName: "",
    setKnowledgeName: () => undefined,
    knowledgeScope: "global",
    setKnowledgeScope: () => undefined,
    canImportProjectKnowledge: true,
    isKnowledgeUrlEditorOpen: false,
    setIsKnowledgeUrlEditorOpen: () => undefined,
    knowledgeUrlInput: "",
    setKnowledgeUrlInput: () => undefined,
    onAddUrls: () => true,
    onChooseSources: () => Promise.resolve(),
    onRemoveSource: () => undefined,
    getSourceKey: () => "source",
    isKnowledgeImporting: false,
    onImport: () => Promise.resolve(),
    snapshot: null,
    knowledgeBases,
    knowledgeDocuments: {},
    knowledgeBusyId: null,
    onRefreshBases: () => Promise.resolve(),
    onToggleDocuments: () => Promise.resolve(),
    onRefreshBase: () => Promise.resolve(),
    onDeleteBase: () => Promise.resolve(),
    formatScope: (scope) => scope,
    formatStatus: (status) => status,
    formatBytes: (bytes) => `${bytes} B`,
    formatRelativeTime: () => "刚刚"
  }));
}

describe("knowledge page actions", () => {
  it("detects database-managed knowledge bases by quick-notes bundle root", () => {
    expect(isDatabaseManagedKnowledgeBase({ bundleRoot: "C:\\Users\\demo\\.codexh\\knowledge\\global\\bundles\\quick-notes" })).toBe(true);
    expect(isDatabaseManagedKnowledgeBase({ bundleRoot: "C:/Users/demo/.codexh/knowledge/global/bundles/quick-notes" })).toBe(true);
    expect(isDatabaseManagedKnowledgeBase({ bundleRoot: "C:\\Users\\demo\\.codexh\\knowledge\\global\\bundles\\82f5fba5" })).toBe(false);
  });

  it("hides the refresh action for quick-notes bases while keeping other actions", () => {
    const markup = renderPage([createBase()]);
    expect(markup).not.toContain(">刷新</button>");
    expect(markup).toContain("查看文档");
  });

  it("keeps the refresh action for file-imported knowledge bases", () => {
    const markup = renderPage([createBase({
      id: "kb-2",
      displayName: "后端框架",
      bundleRoot: "C:\\Users\\demo\\.codexh\\knowledge\\global\\bundles\\82f5fba5"
    })]);
    expect(markup).toContain(">刷新</button>");
  });
});
