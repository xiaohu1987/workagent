import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROJECT_RULE_FRESHNESS_PROBE_FILES,
  collectProjectRuleProbeModifiedAt,
  projectRuleNeedsRefresh,
  refreshProjectRuleFile
} from "../packages/agent-runtime/src/project-rule-update";
import { resolveProjectRuleState } from "../packages/agent-runtime/src/project-rule-inject";
import type { ProjectRuleEntry } from "../packages/agent-runtime/src/project-rule-file";

async function createTempProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-rule-refresh-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, "utf8");
  }
  return root;
}

function findEntry(entries: readonly ProjectRuleEntry[], category: string): ProjectRuleEntry | undefined {
  return entries.find((entry) => entry.category === category);
}

describe("project rule freshness", () => {
  it("treats a manifest newer than the rules as outdated", () => {
    const document = { updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(projectRuleNeedsRefresh(document, ["2026-01-01T00:00:05.000Z"])).toBe(true);
    expect(projectRuleNeedsRefresh(document, ["2025-12-31T23:59:59.000Z"])).toBe(false);
    expect(projectRuleNeedsRefresh(document, [null, undefined, ""])).toBe(false);
    // An unparsable timestamp must not pin the rules forever.
    expect(projectRuleNeedsRefresh({ updatedAt: "not-a-date" }, [])).toBe(true);
  });

  it("probes only the manifests that exist", async () => {
    expect(PROJECT_RULE_FRESHNESS_PROBE_FILES).toContain("package.json");
    const empty = await createTempProject({});
    expect(await collectProjectRuleProbeModifiedAt(empty)).toHaveLength(0);

    const populated = await createTempProject({
      "package.json": JSON.stringify({ name: "demo" }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n"
    });
    const modifiedAt = await collectProjectRuleProbeModifiedAt(populated);
    expect(modifiedAt).toHaveLength(2);
    modifiedAt.forEach((value) => expect(Number.isFinite(Date.parse(value))).toBe(true));
  });

  it("keeps the stored rules when no manifest changed", async () => {
    const root = await createTempProject({
      "package.json": JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n"
    });
    const first = await resolveProjectRuleState(root);
    expect(first?.created).toBe(true);
    expect(findEntry(first!.document.entries, "tech-stack")?.rules.join("\n")).toContain("pnpm");

    const second = await resolveProjectRuleState(root);
    expect(second?.created).toBe(false);
    expect(second!.document.updatedAt).toBe(first!.document.updatedAt);
  });

  it("re-scans and rewrites the rules when a manifest becomes newer", async () => {
    const root = await createTempProject({
      "package.json": JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n"
    });
    const first = await resolveProjectRuleState(root);
    expect(first).not.toBeNull();
    const firstUpdatedAt = first!.document.updatedAt;
    expect(findEntry(first!.document.entries, "tech-stack")?.rules.join("\n")).toContain("pnpm");

    await fs.rm(path.join(root, "pnpm-lock.yaml"));
    const lockfilePath = path.join(root, "package-lock.json");
    await fs.writeFile(lockfilePath, JSON.stringify({ lockfileVersion: 3 }), "utf8");
    const bumpedAt = new Date(Date.parse(firstUpdatedAt) + 60_000);
    await fs.utimes(lockfilePath, bumpedAt, bumpedAt);

    const second = await resolveProjectRuleState(root);
    expect(second?.created).toBe(false);
    expect(second!.document.updatedAt).not.toBe(firstUpdatedAt);
    const refreshedTechStack = findEntry(second!.document.entries, "tech-stack");
    expect(refreshedTechStack?.rules.join("\n")).not.toContain("pnpm");
    await expect(fs.readFile(path.join(root, ".codexh", "rule.md"), "utf8")).resolves.toContain(
      refreshedTechStack!.rules[0]!
    );

    // The refreshed document is the new baseline: another read writes nothing.
    const third = await resolveProjectRuleState(root);
    expect(third!.document.updatedAt).toBe(second!.document.updatedAt);
  });

  it("still refreshes on explicit request", async () => {
    const root = await createTempProject({
      "package.json": JSON.stringify({ name: "demo" })
    });
    const refreshed = await refreshProjectRuleFile(root, { maxChangedEntries: 40 });
    expect(refreshed.filePath.endsWith(path.join(".codexh", "rule.md"))).toBe(true);
    expect(refreshed.document.entries.length).toBeGreaterThan(0);
  });

  it("adds a new entry while keeping every still-valid one", async () => {
    const packageJsonPath = "package.json";
    const root = await createTempProject({
      [packageJsonPath]: JSON.stringify({ name: "demo" })
    });
    await refreshProjectRuleFile(root, { maxChangedEntries: 40 });
    const baseline = await resolveProjectRuleState(root);
    expect(baseline).not.toBeNull();
    const baselineIds = baseline!.document.entries.map((entry) => entry.id);
    expect(baselineIds.length).toBeGreaterThan(0);
    expect(findEntry(baseline!.document.entries, "verify")?.rules.join("\n")).not.toContain("vitest");

    await fs.writeFile(
      path.join(root, packageJsonPath),
      JSON.stringify({ name: "demo", scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
      "utf8"
    );
    const bumpedAt = new Date(Date.parse(baseline!.document.updatedAt) + 60_000);
    await fs.utimes(path.join(root, packageJsonPath), bumpedAt, bumpedAt);

    const next = await refreshProjectRuleFile(root, { maxChangedEntries: 40 });
    expect(next.changed).toBeGreaterThan(0);
    expect(next.requiresConfirmation).toBe(false);
    const verifyEntry = findEntry(next.document.entries, "verify");
    expect(verifyEntry?.rules.join("\n")).toContain("vitest");
    expect([...next.added, ...next.updated]).toContain(verifyEntry!.id);
    const nextIds = next.document.entries.map((entry) => entry.id);
    baselineIds.forEach((id) => expect(nextIds).toContain(id));
    // 过期条目只做标记、不删除，因此条目数不会减少。
    expect(next.document.entries.length).toBeGreaterThanOrEqual(baselineIds.length);
  });
});
