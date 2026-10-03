import fs from "node:fs/promises";
import path from "node:path";

import {
  MAX_PROJECT_RULE_ENTRIES,
  nextProjectRuleId,
  sortProjectRuleEntries,
  writeProjectRuleFile,
  type ProjectRuleDocument,
  type ProjectRuleEntry
} from "./project-rule-file";
import { buildProjectRuleEntriesFromFacts, ensureProjectRuleFile } from "./project-rule-bootstrap";
import { scanProjectFacts, type ProjectScanFacts } from "./project-rule-scan";
import { buildProjectRuleEntrySkeleton } from "./project-rule-template";

/**
 * Incremental maintenance of `.codexh/rule.md`.
 *
 * Facts are re-scanned and merged into the existing document. Entries are
 * matched by a stable key (category + title) so an entry keeps its id across
 * updates, which keeps the change surface small and diff-friendly. The merge
 * only adds or refines `auto` entries, marks entries that the facts no longer
 * back as `stale`, and never deletes anything. An update that would touch more
 * entries than the budget allows is downgraded to a confirmation prompt instead
 * of silently rewriting the file.
 */
export const MAX_PROJECT_RULE_AUTO_UPDATE_ENTRIES = 6;

export interface ProjectRuleMergeOptions {
  /** Upper bound of entries a single automatic update may touch. */
  maxChangedEntries?: number;
  /** Upper bound of entries the document may hold. */
  maxEntries?: number;
}

export interface ProjectRuleMergeResult {
  /** The document to persist; identical to the input when nothing changed. */
  document: ProjectRuleDocument;
  added: string[];
  updated: string[];
  staleMarked: string[];
  /** Entries authored by the user that the automatic update skipped. */
  preserved: string[];
  changed: number;
  requiresConfirmation: boolean;
  message: string | null;
}

export interface ProjectRuleRefreshResult extends ProjectRuleMergeResult {
  filePath: string;
  /** `true` when this call actually touched the file on disk. */
  written: boolean;
  facts: ProjectScanFacts;
}

/** Manifest files whose modification can invalidate the stored project rules. */
export const PROJECT_RULE_FRESHNESS_PROBE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  "tsconfig.json",
  "vitest.config.ts"
] as const;

/**
 * Decides whether the stored rules are older than the project manifests.
 *
 * Only the manifests are probed, so a session start stays cheap: the project is
 * re-scanned and merged only when a manifest really changed after the last
 * write. An unparsable timestamp counts as outdated so the rules self-heal.
 */
export function projectRuleNeedsRefresh(
  document: Pick<ProjectRuleDocument, "updatedAt">,
  probeModifiedAt: readonly (string | null | undefined)[]
): boolean {
  const updatedAt = Date.parse(document.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return probeModifiedAt.some((value) => {
    if (!value) return false;
    const modifiedAt = Date.parse(value);
    return Number.isFinite(modifiedAt) && modifiedAt > updatedAt;
  });
}

/** Reads the modification times of the manifest probes that actually exist. */
export async function collectProjectRuleProbeModifiedAt(cwd: string): Promise<string[]> {
  const probes = PROJECT_RULE_FRESHNESS_PROBE_FILES.map((name) => path.join(cwd, name));
  const modifiedAt = await Promise.all(
    probes.map(async (filePath) => {
      try {
        const stats = await fs.stat(filePath);
        return stats.mtime.toISOString();
      } catch {
        return null;
      }
    })
  );
  return modifiedAt.filter((value): value is string => value !== null);
}

/** Stable identity used to match a freshly scanned entry to a stored one. */
export function projectRuleEntryKey(entry: Pick<ProjectRuleEntry, "category" | "title">): string {
  return `${entry.category}::${entry.title.trim()}`;
}

function sameRules(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((rule, index) => rule.trim() === (b[index] ?? "").trim());
}

function sameContent(entry: ProjectRuleEntry, fresh: ProjectRuleEntry): boolean {
  return entry.scope === fresh.scope && sameRules(entry.rules, fresh.rules);
}

export function buildProjectRuleUpdateMessage(
  changed: number,
  maxChangedEntries: number,
  entryCount: number,
  maxEntries: number
): string {
  const reasons: string[] = [];
  if (changed > maxChangedEntries) {
    reasons.push(`本次更新涉及 ${changed} 条条目，超过自动改写上限 ${maxChangedEntries} 条`);
  }
  if (entryCount > maxEntries) {
    reasons.push(`条目总数将达到 ${entryCount} 条，超过上限 ${maxEntries} 条`);
  }
  return `${reasons.join("；")}。为避免误删仍有效的条目，本次不自动改写 \`.codexh/rule.md\`，请确认后再合并。`;
}

/**
 * Merges scanned entries into a stored document. Pure and synchronous so the
 * merge rules can be verified without touching the file system.
 */
export function mergeProjectRuleDocument(
  existing: ProjectRuleDocument,
  fresh: readonly ProjectRuleEntry[],
  updatedAt: string,
  options?: ProjectRuleMergeOptions
): ProjectRuleMergeResult {
  const maxChangedEntries = options?.maxChangedEntries ?? MAX_PROJECT_RULE_AUTO_UPDATE_ENTRIES;
  const maxEntries = options?.maxEntries ?? MAX_PROJECT_RULE_ENTRIES;
  const existingSorted = sortProjectRuleEntries(existing.entries);
  const entries: ProjectRuleEntry[] = [...existingSorted];
  const byKey = new Map<string, number>();
  existingSorted.forEach((entry, index) => {
    const key = projectRuleEntryKey(entry);
    if (!byKey.has(key)) byKey.set(key, index);
  });

  const matched = new Set<number>();
  const added: string[] = [];
  const updated: string[] = [];
  const preserved: string[] = [];

  for (const candidate of fresh) {
    const key = projectRuleEntryKey(candidate);
    const index = byKey.get(key);
    if (index === undefined) {
      const entry = buildProjectRuleEntrySkeleton({
        category: candidate.category,
        id: nextProjectRuleId(candidate.category, entries),
        title: candidate.title,
        scope: candidate.scope,
        rules: [...candidate.rules],
        source: "auto",
        updatedAt
      });
      entries.push(entry);
      byKey.set(key, entries.length - 1);
      added.push(entry.id);
      continue;
    }
    const current = entries[index]!;
    matched.add(index);
    if (current.source === "user") {
      preserved.push(current.id);
      continue;
    }
    if (sameContent(current, candidate)) continue;
    entries[index] = {
      ...current,
      scope: candidate.scope,
      rules: [...candidate.rules],
      stale: false,
      updatedAt
    };
    updated.push(current.id);
  }

  const staleMarked: string[] = [];
  for (let index = 0; index < existingSorted.length; index += 1) {
    const entry = entries[index]!;
    if (entry.source !== "auto" || entry.stale || matched.has(index)) continue;
    entries[index] = { ...entry, stale: true };
    staleMarked.push(entry.id);
  }

  const changed = added.length + updated.length + staleMarked.length;
  if (changed === 0) {
    return {
      document: existing,
      added,
      updated,
      staleMarked,
      preserved,
      changed,
      requiresConfirmation: false,
      message: null
    };
  }

  if (changed > maxChangedEntries || entries.length > maxEntries) {
    return {
      document: existing,
      added,
      updated,
      staleMarked,
      preserved,
      changed,
      requiresConfirmation: true,
      message: buildProjectRuleUpdateMessage(changed, maxChangedEntries, entries.length, maxEntries)
    };
  }

  return {
    document: { version: existing.version, updatedAt, entries },
    added,
    updated,
    staleMarked,
    preserved,
    changed,
    requiresConfirmation: false,
    message: null
  };
}

/**
 * Re-scans the project and folds the facts into `.codexh/rule.md`.
 *
 * The file is written only when the merge produced a change, so an unchanged
 * project never rewrites the rule file.
 */
export async function refreshProjectRuleFile(
  cwd: string,
  options?: ProjectRuleMergeOptions & { maxDepth?: number }
): Promise<ProjectRuleRefreshResult> {
  const bootstrapped = await ensureProjectRuleFile(cwd, { maxDepth: options?.maxDepth });
  const facts = bootstrapped.facts ?? (await scanProjectFacts(cwd, { maxDepth: options?.maxDepth }));
  const updatedAt = new Date().toISOString();
  const fresh = buildProjectRuleEntriesFromFacts(facts, updatedAt);
  const merged = mergeProjectRuleDocument(bootstrapped.document, fresh, updatedAt, options);
  const shouldWrite = !bootstrapped.created && merged.changed > 0 && !merged.requiresConfirmation;
  return {
    ...merged,
    filePath: shouldWrite ? await writeProjectRuleFile(cwd, merged.document) : bootstrapped.filePath,
    written: bootstrapped.created || shouldWrite,
    facts
  };
}
