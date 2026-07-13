import type { CodeSymbol } from "./symbols";
import { findEnclosingSymbol } from "./symbols";

export interface HunkLines {
  lines: string[];
}

export interface LocateResult {
  start: number;
  deleteCount: number;
  replacement: string[];
  mode: "ast" | "text";
}

function parseHunkParts(hunk: HunkLines): {
  oldBlock: string[];
  newBlock: string[];
} {
  const oldBlock: string[] = [];
  const newBlock: string[] = [];

  for (const raw of hunk.lines) {
    if (!raw.length) {
      continue;
    }
    const prefix = raw[0];
    const body = raw.slice(1);
    if (prefix === " " || prefix === "-") {
      oldBlock.push(body);
    }
    if (prefix === " " || prefix === "+") {
      newBlock.push(body);
    }
  }

  return { oldBlock, newBlock };
}

function findSequenceMatches(haystack: string[], needle: string[], from = 0, to = haystack.length): number[] {
  if (needle.length === 0) {
    return [];
  }
  const matches: number[] = [];
  const lastStart = Math.max(from, Math.min(to, haystack.length) - needle.length);
  for (let i = from; i <= lastStart; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push(i);
    }
  }
  return matches;
}

function inferAnchorLine(hunk: HunkLines): number | null {
  for (const line of hunk.lines) {
    if (line.startsWith("@@")) {
      const match = /@@\s+-(\d+)/.exec(line);
      if (match) {
        return Math.max(0, Number(match[1]) - 1);
      }
    }
  }
  return null;
}

/**
 * Locate where a hunk should apply. Prefers unique full old-block match,
 * optionally constrained to an enclosing AST symbol. Ambiguity throws.
 * Never appends to EOF on miss.
 */
export function locateHunk(
  currentLines: string[],
  hunk: HunkLines,
  symbols: CodeSymbol[] | null
): LocateResult {
  const { oldBlock, newBlock } = parseHunkParts(hunk);

  if (oldBlock.length === 0) {
    if (newBlock.length === 0) {
      throw new Error("Patch hunk is empty.");
    }
    throw new Error("Patch hunk has no context or removal lines to locate an insertion.");
  }

  let matches = findSequenceMatches(currentLines, oldBlock);
  let mode: "ast" | "text" = "text";

  if (matches.length > 1 && symbols && symbols.length > 0) {
    const narrowed = narrowBySymbols(matches, oldBlock.length, symbols, hunk);
    if (narrowed.length >= 1) {
      matches = narrowed;
      if (narrowed.length === 1) {
        mode = "ast";
      }
    }
  } else if (matches.length === 1 && symbols && symbols.length > 0) {
    mode = "ast";
  }

  if (matches.length === 0) {
    throw new Error("Patch hunk context/removal block was not found in the target file.");
  }

  if (matches.length > 1) {
    const hinted = inferAnchorLine(hunk);
    if (hinted !== null) {
      const near = matches
        .map((m) => ({ m, dist: Math.abs(m - hinted) }))
        .sort((a, b) => a.dist - b.dist);
      if (near.length >= 2 && near[0].dist < near[1].dist) {
        return {
          start: near[0].m,
          deleteCount: oldBlock.length,
          replacement: newBlock,
          mode
        };
      }
    }
    throw new Error(
      `Ambiguous patch hunk matched ${matches.length} locations; add more unique context or target a specific symbol.`
    );
  }

  return {
    start: matches[0],
    deleteCount: oldBlock.length,
    replacement: newBlock,
    mode
  };
}

function narrowBySymbols(
  matches: number[],
  blockLength: number,
  symbols: CodeSymbol[],
  hunk: HunkLines
): number[] {
  const removalOrContext = hunk.lines
    .filter((line) => line.startsWith(" ") || line.startsWith("-"))
    .map((line) => line.slice(1));
  const nameHint = inferSymbolNameHint(removalOrContext);

  return matches.filter((start) => {
    const end = start + Math.max(blockLength, 1) - 1;
    const enclosingStart = findEnclosingSymbol(symbols, start);
    const enclosingEnd = findEnclosingSymbol(symbols, end);
    if (nameHint) {
      return (
        (enclosingStart && enclosingStart.name === nameHint) ||
        (enclosingEnd && enclosingEnd.name === nameHint) ||
        symbols.some(
          (symbol) =>
            symbol.name === nameHint && start >= symbol.startLine && end <= symbol.endLine
        )
      );
    }
    return Boolean(enclosingStart || enclosingEnd);
  });
}

function inferSymbolNameHint(lines: string[]): string | null {
  for (const line of lines) {
    const patterns = [
      /\b(?:function|def|func|fn|class|interface|struct|enum|trait|impl|module|type)\s+([A-Za-z_][\w]*)/,
      /\b([A-Za-z_][\w]*)\s*\([^)]*\)\s*\{/
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match?.[1] && !/^(if|for|while|switch)$/.test(match[1])) {
        return match[1];
      }
    }
  }
  return null;
}

export function applyLocatedHunk(currentLines: string[], location: LocateResult): string[] {
  const next = currentLines.slice();
  next.splice(location.start, location.deleteCount, ...location.replacement);
  return next;
}

export function countHunkEdits(hunk: HunkLines): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of hunk.lines) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}
