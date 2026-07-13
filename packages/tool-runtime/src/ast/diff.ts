import type { CodeSymbol } from "./symbols";

export type EntityChangeType = "added" | "removed" | "modified" | "renamed";

export interface EntityChange {
  name: string;
  kind: string;
  change: EntityChangeType;
  previousName?: string;
  oldHash?: string;
  newHash?: string;
  startLine?: number;
  endLine?: number;
}

function keyOf(symbol: CodeSymbol): string {
  return `${symbol.kind}:${symbol.name}`;
}

/**
 * Entity-level diff: match by kind+name, detect renames via identical hash.
 */
export function diffEntities(before: CodeSymbol[], after: CodeSymbol[]): EntityChange[] {
  const beforeByKey = new Map<string, CodeSymbol[]>();
  const afterByKey = new Map<string, CodeSymbol[]>();

  for (const symbol of before) {
    const list = beforeByKey.get(keyOf(symbol)) ?? [];
    list.push(symbol);
    beforeByKey.set(keyOf(symbol), list);
  }
  for (const symbol of after) {
    const list = afterByKey.get(keyOf(symbol)) ?? [];
    list.push(symbol);
    afterByKey.set(keyOf(symbol), list);
  }

  const changes: EntityChange[] = [];
  const usedAfter = new Set<CodeSymbol>();
  const usedBefore = new Set<CodeSymbol>();

  for (const [key, beforeList] of beforeByKey) {
    const afterList = afterByKey.get(key) ?? [];
    const count = Math.min(beforeList.length, afterList.length);
    for (let i = 0; i < count; i += 1) {
      const left = beforeList[i];
      const right = afterList[i];
      usedBefore.add(left);
      usedAfter.add(right);
      if (left.hash !== right.hash) {
        changes.push({
          name: right.name,
          kind: right.kind,
          change: "modified",
          oldHash: left.hash,
          newHash: right.hash,
          startLine: right.startLine,
          endLine: right.endLine
        });
      }
    }
  }

  const remainingBefore = before.filter((s) => !usedBefore.has(s));
  const remainingAfter = after.filter((s) => !usedAfter.has(s));

  // Rename detection: same kind + identical body hash, different name
  for (const left of [...remainingBefore]) {
    const renameIdx = remainingAfter.findIndex(
      (right) => right.kind === left.kind && right.hash === left.hash && right.name !== left.name
    );
    if (renameIdx >= 0) {
      const right = remainingAfter[renameIdx];
      remainingAfter.splice(renameIdx, 1);
      const removeAt = remainingBefore.indexOf(left);
      if (removeAt >= 0) {
        remainingBefore.splice(removeAt, 1);
      }
      changes.push({
        name: right.name,
        kind: right.kind,
        change: "renamed",
        previousName: left.name,
        oldHash: left.hash,
        newHash: right.hash,
        startLine: right.startLine,
        endLine: right.endLine
      });
    }
  }

  for (const left of remainingBefore) {
    changes.push({
      name: left.name,
      kind: left.kind,
      change: "removed",
      oldHash: left.hash,
      startLine: left.startLine,
      endLine: left.endLine
    });
  }

  for (const right of remainingAfter) {
    changes.push({
      name: right.name,
      kind: right.kind,
      change: "added",
      newHash: right.hash,
      startLine: right.startLine,
      endLine: right.endLine
    });
  }

  return changes.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
}

export function formatEntityChanges(changes: EntityChange[]): string {
  if (changes.length === 0) {
    return "No entity-level changes.";
  }
  return changes
    .map((change) => {
      const span =
        change.startLine !== undefined
          ? ` @${change.startLine + 1}-${(change.endLine ?? change.startLine) + 1}`
          : "";
      if (change.change === "renamed") {
        return `- renamed ${change.kind} ${change.previousName} -> ${change.name}${span}`;
      }
      return `- ${change.change} ${change.kind} ${change.name}${span}`;
    })
    .join("\n");
}
