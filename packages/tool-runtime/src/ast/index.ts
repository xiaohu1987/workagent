export {
  languageFromPath,
  isAstSupportedPath,
  wasmFileForLanguage,
  type AstLanguageId
} from "./languages";
export { isAstEngineAvailable, loadLanguage, parseSource } from "./parser";
export {
  extractSymbols,
  extractSymbolsHeuristic,
  findEnclosingSymbol,
  type CodeSymbol
} from "./symbols";
export {
  locateHunk,
  applyLocatedHunk,
  countHunkEdits,
  type HunkLines,
  type LocateResult
} from "./locate";
export {
  diffEntities,
  formatEntityChanges,
  type EntityChange,
  type EntityChangeType
} from "./diff";

import { languageFromPath } from "./languages";
import { extractSymbols } from "./symbols";
import { diffEntities, formatEntityChanges, type EntityChange } from "./diff";

export async function astDiffSources(
  before: string,
  after: string,
  filePath: string
): Promise<{ language: string | null; entities: EntityChange[]; summary: string }> {
  const language = languageFromPath(filePath);
  if (!language) {
    return {
      language: null,
      entities: [],
      summary: `Unsupported language for AST diff: ${filePath}`
    };
  }
  const beforeSymbols = await extractSymbols(before, language);
  const afterSymbols = await extractSymbols(after, language);
  const entities = diffEntities(beforeSymbols, afterSymbols);
  return {
    language,
    entities,
    summary: formatEntityChanges(entities)
  };
}
