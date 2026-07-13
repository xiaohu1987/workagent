import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { AstLanguageId } from "./languages";
import { wasmFileForLanguage } from "./languages";

type TreeSitterModule = typeof import("web-tree-sitter");
type ParserInstance = InstanceType<TreeSitterModule["Parser"]>;
type LanguageInstance = Awaited<ReturnType<TreeSitterModule["Language"]["load"]>>;

const require = createRequire(import.meta.url);

let ParserCtor: TreeSitterModule["Parser"] | null = null;
let LanguageCtor: TreeSitterModule["Language"] | null = null;
let initPromise: Promise<boolean> | null = null;
let initFailed = false;
const languageCache = new Map<AstLanguageId, LanguageInstance>();

function candidateGrammarDirs(): string[] {
  const dirs: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    dirs.push(path.join(resourcesPath, "tree-sitter-grammars"));
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  dirs.push(path.resolve(here, "../../../../assets/tree-sitter-grammars"));
  dirs.push(path.resolve(process.cwd(), "assets/tree-sitter-grammars"));

  try {
    const wasmsRoot = path.dirname(require.resolve("tree-sitter-wasms/package.json"));
    dirs.push(path.join(wasmsRoot, "out"));
  } catch {
    // optional dependency path
  }

  return dirs;
}

function resolveGrammarPath(language: AstLanguageId): string | null {
  const fileName = wasmFileForLanguage(language);
  for (const dir of candidateGrammarDirs()) {
    const full = path.join(dir, fileName);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  return null;
}

function resolveTreeSitterWasm(): string | null {
  const candidates = [
    ...candidateGrammarDirs().map((dir) => path.join(dir, "tree-sitter.wasm")),
    (() => {
      try {
        return path.join(path.dirname(require.resolve("web-tree-sitter/package.json")), "tree-sitter.wasm");
      } catch {
        return null;
      }
    })()
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function ensureInitialized(): Promise<boolean> {
  if (initFailed) {
    return false;
  }
  if (ParserCtor && LanguageCtor) {
    return true;
  }
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const mod = (await import("web-tree-sitter")) as TreeSitterModule & {
          default?: TreeSitterModule;
        };
        const ts = (mod.default ?? mod) as TreeSitterModule;
        ParserCtor = ts.Parser;
        LanguageCtor = ts.Language;
        const wasmPath = resolveTreeSitterWasm();
        if (wasmPath) {
          await ParserCtor.init({
            locateFile: (scriptName: string) => {
              if (scriptName === "tree-sitter.wasm") {
                return wasmPath;
              }
              return scriptName;
            }
          } as ConstructorParameters<typeof ParserCtor.init>[0]);
        } else {
          await ParserCtor.init();
        }
        return true;
      } catch {
        initFailed = true;
        ParserCtor = null;
        LanguageCtor = null;
        return false;
      }
    })();
  }
  return initPromise;
}

export async function isAstEngineAvailable(): Promise<boolean> {
  return ensureInitialized();
}

export async function loadLanguage(language: AstLanguageId): Promise<LanguageInstance | null> {
  if (!(await ensureInitialized()) || !LanguageCtor) {
    return null;
  }
  const cached = languageCache.get(language);
  if (cached) {
    return cached;
  }
  const grammarPath = resolveGrammarPath(language);
  if (!grammarPath) {
    return null;
  }
  try {
    const loaded = await LanguageCtor.load(grammarPath);
    languageCache.set(language, loaded);
    return loaded;
  } catch {
    return null;
  }
}

export async function parseSource(
  source: string,
  language: AstLanguageId
): Promise<{ tree: { rootNode: unknown }; parser: ParserInstance } | null> {
  if (!(await ensureInitialized()) || !ParserCtor) {
    return null;
  }
  const lang = await loadLanguage(language);
  if (!lang) {
    return null;
  }
  const parser = new ParserCtor();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) {
    parser.delete();
    return null;
  }
  return { tree, parser };
}
