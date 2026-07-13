declare module "web-tree-sitter" {
  export class Parser {
    static init(moduleOptions?: unknown): Promise<void>;
    setLanguage(language: Language): void;
    parse(input: string): Tree | null;
    getLanguage(): Language;
    delete(): void;
  }

  export class Language {
    static load(input: string | Uint8Array): Promise<Language>;
  }

  export class Query {
    constructor(language: Language, source: string);
    matches(node: SyntaxNode): Array<{ captures: Array<{ name: string; node: SyntaxNode }> }>;
    delete(): void;
  }

  export interface SyntaxNode {
    type: string;
    text: string;
    startIndex: number;
    endIndex: number;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
  }

  export interface Tree {
    rootNode: SyntaxNode;
  }

  const TreeSitter: {
    Parser: typeof Parser;
    Language: typeof Language;
    Query: typeof Query;
  };

  export default TreeSitter;
}
