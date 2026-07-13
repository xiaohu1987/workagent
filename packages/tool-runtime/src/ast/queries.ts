import type { AstLanguageId } from "./languages";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "impl"
  | "module"
  | "type"
  | "const"
  | "variable";

/** Tree-sitter query strings keyed by language. Capture names: @name @def */
export const SYMBOL_QUERIES: Partial<Record<AstLanguageId, string>> = {
  typescript: `
(function_declaration name: (identifier) @name) @def
(class_declaration name: (type_identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(interface_declaration name: (type_identifier) @name) @def
(type_alias_declaration name: (type_identifier) @name) @def
(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function))) @def
(export_statement declaration: (function_declaration name: (identifier) @name)) @def
(export_statement declaration: (class_declaration name: (type_identifier) @name)) @def
`,
  tsx: `
(function_declaration name: (identifier) @name) @def
(class_declaration name: (type_identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(interface_declaration name: (type_identifier) @name) @def
(type_alias_declaration name: (type_identifier) @name) @def
(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function))) @def
`,
  javascript: `
(function_declaration name: (identifier) @name) @def
(class_declaration name: (identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function))) @def
(lexical_declaration (variable_declarator name: (identifier) @name value: (function_expression))) @def
`,
  python: `
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @def
`,
  go: `
(function_declaration name: (identifier) @name) @def
(method_declaration name: (field_identifier) @name) @def
(type_declaration (type_spec name: (type_identifier) @name)) @def
`,
  java: `
(method_declaration name: (identifier) @name) @def
(class_declaration name: (identifier) @name) @def
(interface_declaration name: (identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(constructor_declaration name: (identifier) @name) @def
`,
  c_sharp: `
(method_declaration name: (identifier) @name) @def
(class_declaration name: (identifier) @name) @def
(interface_declaration name: (identifier) @name) @def
(struct_declaration name: (identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(constructor_declaration name: (identifier) @name) @def
`,
  rust: `
(function_item name: (identifier) @name) @def
(struct_item name: (type_identifier) @name) @def
(enum_item name: (type_identifier) @name) @def
(impl_item type: (type_identifier) @name) @def
(trait_item name: (type_identifier) @name) @def
(mod_item name: (identifier) @name) @def
`,
  c: `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
(type_definition type: (_) declarator: (type_identifier) @name) @def
(struct_specifier name: (type_identifier) @name) @def
(enum_specifier name: (type_identifier) @name) @def
`,
  cpp: `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
(class_specifier name: (type_identifier) @name) @def
(struct_specifier name: (type_identifier) @name) @def
(enum_specifier name: (type_identifier) @name) @def
`,
  kotlin: `
(function_declaration (simple_identifier) @name) @def
(class_declaration (type_identifier) @name) @def
(object_declaration (type_identifier) @name) @def
`,
  php: `
(function_definition name: (name) @name) @def
(class_declaration name: (name) @name) @def
(method_declaration name: (name) @name) @def
(interface_declaration name: (name) @name) @def
`,
  ruby: `
(method name: (identifier) @name) @def
(class name: (constant) @name) @def
(module name: (constant) @name) @def
`
};

export function kindFromNodeType(nodeType: string): SymbolKind {
  const type = nodeType.toLowerCase();
  if (type.includes("class") || type.includes("object_declaration")) return "class";
  if (type.includes("interface") || type.includes("trait")) return "interface";
  if (type.includes("struct")) return "struct";
  if (type.includes("enum")) return "enum";
  if (type.includes("impl")) return "impl";
  if (type.includes("mod") || type.includes("module")) return "module";
  if (type.includes("type_alias") || type.includes("type_declaration") || type.includes("type_definition") || type.includes("type_spec")) {
    return "type";
  }
  if (type.includes("method") || type.includes("constructor")) return "method";
  if (type.includes("function") || type.includes("lexical_declaration") || type.includes("export_statement")) {
    return "function";
  }
  return "function";
}
