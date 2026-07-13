import { createHash } from "node:crypto";
import type { AstLanguageId } from "./languages";
import { parseSource } from "./parser";
import { SYMBOL_QUERIES, kindFromNodeType, type SymbolKind } from "./queries";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
  text: string;
  hash: string;
}

type SyntaxNode = {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childForFieldName?: (name: string) => SyntaxNode | null;
};

type QueryCapture = { name: string; node: SyntaxNode };
type QueryMatch = { captures: QueryCapture[] };

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function lineOfIndex(source: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

function pushSymbol(
  symbols: CodeSymbol[],
  source: string,
  name: string,
  kind: SymbolKind,
  startIndex: number,
  endIndex: number
): void {
  const text = source.slice(startIndex, endIndex);
  // Name-insensitive hash so identical bodies with renamed identifiers can be detected.
  const normalized = text.replaceAll(name, "§name§");
  symbols.push({
    name,
    kind,
    startLine: lineOfIndex(source, startIndex),
    endLine: lineOfIndex(source, Math.max(startIndex, endIndex - 1)),
    startIndex,
    endIndex,
    text,
    hash: hashText(normalized)
  });
}

/** Regex/heuristic extractor used when tree-sitter is unavailable. */
export function extractSymbolsHeuristic(source: string, language: AstLanguageId): CodeSymbol[] {
  const patterns: Array<{ kind: SymbolKind; regex: RegExp }> = [];

  if (language === "python") {
    patterns.push(
      { kind: "class", regex: /^[ \t]*class[ \t]+([A-Za-z_][\w]*)/gm },
      { kind: "function", regex: /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_][\w]*)/gm }
    );
  } else if (language === "go") {
    patterns.push(
      { kind: "function", regex: /^func[ \t]+(?:\([^)]+\)[ \t]+)?([A-Za-z_][\w]*)/gm },
      { kind: "type", regex: /^type[ \t]+([A-Za-z_][\w]*)/gm }
    );
  } else if (language === "java" || language === "c_sharp" || language === "kotlin") {
    patterns.push(
      { kind: "class", regex: /\b(?:class|interface|enum|struct|object)\s+([A-Za-z_][\w]*)/g },
      { kind: "method", regex: /\b(?:public|private|protected|internal|static|async|override|virtual|final|synchronized|fun)\s+(?:[\w.<>,\[\]?]+\s+)?([A-Za-z_][\w]*)\s*\(/g }
    );
  } else if (language === "rust") {
    patterns.push(
      { kind: "function", regex: /\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/g },
      { kind: "struct", regex: /\b(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/g },
      { kind: "enum", regex: /\b(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/g },
      { kind: "impl", regex: /\bimpl(?:\s*<[^>]*>)?\s+(?:(?:[\w:]+)\s+for\s+)?([A-Za-z_][\w:]*)/g },
      { kind: "interface", regex: /\b(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/g }
    );
  } else if (language === "ruby") {
    patterns.push(
      { kind: "class", regex: /^[ \t]*class[ \t]+([A-Za-z_][\w]*)/gm },
      { kind: "module", regex: /^[ \t]*module[ \t]+([A-Za-z_][\w]*)/gm },
      { kind: "method", regex: /^[ \t]*def[ \t]+([A-Za-z_][\w.?!]*)/gm }
    );
  } else if (language === "php") {
    patterns.push(
      { kind: "class", regex: /\b(?:class|interface|trait|enum)\s+([A-Za-z_][\w]*)/g },
      { kind: "function", regex: /\bfunction\s+([A-Za-z_][\w]*)\s*\(/g }
    );
  } else if (language === "c" || language === "cpp") {
    patterns.push(
      { kind: "class", regex: /\b(?:class|struct|enum|union)\s+([A-Za-z_][\w]*)/g },
      { kind: "function", regex: /^[ \t]*(?:[\w:*&\s]+)\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{/gm }
    );
  } else {
    // typescript / tsx / javascript
    patterns.push(
      { kind: "class", regex: /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/g },
      { kind: "interface", regex: /\b(?:export\s+)?interface\s+([A-Za-z_][\w]*)/g },
      { kind: "type", regex: /\b(?:export\s+)?type\s+([A-Za-z_][\w]*)\s*=/g },
      { kind: "function", regex: /\b(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_][\w]*)/g },
      { kind: "function", regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][\w]*)\s*=>/g },
      { kind: "method", regex: /^\s*(?:async\s+)?([A-Za-z_][\w]*)\s*\([^)]*\)\s*\{/gm }
    );
  }

  const symbols: CodeSymbol[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(source)) !== null) {
      const name = match[1];
      if (!name || /^(if|for|while|switch|catch|return|new|typeof|await|from)$/.test(name)) {
        continue;
      }
      const startIndex = match.index;
      const endIndex = estimateBlockEnd(source, startIndex);
      const key = `${pattern.kind}:${name}:${startIndex}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pushSymbol(symbols, source, name, pattern.kind, startIndex, endIndex);
    }
  }

  return symbols.sort((a, b) => a.startIndex - b.startIndex);
}

function estimateBlockEnd(source: string, startIndex: number): number {
  const brace = source.indexOf("{", startIndex);
  const colon = source.indexOf(":", startIndex);
  const newline = source.indexOf("\n", startIndex);

  // Python-style: indent block until dedent
  if ((colon >= 0 && (brace < 0 || colon < brace)) && (newline < 0 || colon < newline + 80)) {
    const lineStart = source.lastIndexOf("\n", startIndex) + 1;
    const indentMatch = /^[ \t]*/.exec(source.slice(lineStart, startIndex + 1));
    const baseIndent = indentMatch?.[0].length ?? 0;
    let i = newline >= 0 ? newline + 1 : source.length;
    while (i < source.length) {
      const nextNl = source.indexOf("\n", i);
      const lineEnd = nextNl < 0 ? source.length : nextNl;
      const line = source.slice(i, lineEnd);
      if (line.trim().length > 0) {
        const lineIndent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
        if (lineIndent <= baseIndent) {
          return i;
        }
      }
      if (nextNl < 0) {
        return source.length;
      }
      i = nextNl + 1;
    }
    return source.length;
  }

  if (brace < 0) {
    return newline >= 0 ? newline : source.length;
  }

  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return source.length;
}

async function extractSymbolsFromTree(source: string, language: AstLanguageId): Promise<CodeSymbol[] | null> {
  const parsed = await parseSource(source, language);
  if (!parsed) {
    return null;
  }

  const querySource = SYMBOL_QUERIES[language];
  if (!querySource) {
    parsed.parser.delete();
    return null;
  }

  try {
    // web-tree-sitter 0.25: Query class from the module
    const ts = await import("web-tree-sitter");
    const mod = (ts as { default?: typeof ts }).default ?? ts;
    const Query = (mod as { Query?: new (language: unknown, source: string) => { matches: (node: unknown) => QueryMatch[]; delete?: () => void } }).Query;
    if (!Query) {
      parsed.parser.delete();
      return null;
    }
    const lang = parsed.parser.getLanguage();
    const query = new Query(lang, querySource);
    const matches = query.matches(parsed.tree.rootNode);
    const symbols: CodeSymbol[] = [];
    const seen = new Set<string>();

    for (const match of matches) {
      const nameCapture = match.captures.find((c) => c.name === "name");
      const defCapture = match.captures.find((c) => c.name === "def") ?? nameCapture;
      if (!nameCapture || !defCapture) {
        continue;
      }
      const name = nameCapture.node.text;
      const node = defCapture.node;
      const key = `${name}:${node.startIndex}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pushSymbol(
        symbols,
        source,
        name,
        kindFromNodeType(node.type),
        node.startIndex,
        node.endIndex
      );
    }

    query.delete?.();
    parsed.parser.delete();
    return symbols.sort((a, b) => a.startIndex - b.startIndex);
  } catch {
    try {
      parsed.parser.delete();
    } catch {
      // ignore
    }
    return null;
  }
}

export async function extractSymbols(source: string, language: AstLanguageId): Promise<CodeSymbol[]> {
  const fromTree = await extractSymbolsFromTree(source, language);
  if (fromTree && fromTree.length > 0) {
    return fromTree;
  }
  return extractSymbolsHeuristic(source, language);
}

export function findEnclosingSymbol(symbols: CodeSymbol[], line: number): CodeSymbol | null {
  let best: CodeSymbol | null = null;
  for (const symbol of symbols) {
    if (line >= symbol.startLine && line <= symbol.endLine) {
      if (!best || symbol.endLine - symbol.startLine < best.endLine - best.startLine) {
        best = symbol;
      }
    }
  }
  return best;
}
