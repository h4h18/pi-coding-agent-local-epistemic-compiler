import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";
import { buildUnitsFromSpans, chunkSource, type RawSpan } from "../ingestion/chunker.js";
import { INDEX_LIMITS, LimitError, assertWithinBudget } from "../ingestion/limits.js";
import type { IndexUnit, UnitKind } from "../ingestion/types.js";
import type { SnapshotId } from "@pi-hec/contracts";
import { resolvePinnedGrammarBytes, UnpinnedGrammarError } from "./pinned-grammars.js";

export type TreeSitterStatus = {
  runtimeReady: boolean;
  loadedLanguages: readonly string[];
};

export { UnpinnedGrammarError };

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Language>();

export async function initTreeSitterRuntime(): Promise<void> {
  if (initPromise === undefined) {
    initPromise = (async () => {
      const wasmUrl = import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm");
      const wasmPath = fileURLToPath(wasmUrl);
      await Parser.init({
        locateFile(scriptName: string): string {
          if (scriptName.endsWith(".wasm")) {
            return wasmPath;
          }
          return scriptName;
        },
      });
    })();
  }
  await initPromise;
}

function kindForNode(type: string, parentClass: string | undefined): UnitKind | undefined {
  switch (type) {
    case "class_declaration":
    case "abstract_class_declaration":
    case "class_definition":
      return "class";
    case "function_declaration":
    case "generator_function_declaration":
    case "function_definition":
      return parentClass !== undefined ? "method" : "function";
    case "method_definition":
      return "method";
    case "interface_declaration":
    case "enum_declaration":
    case "type_alias_declaration":
      return "top-level";
    default:
      return undefined;
  }
}

function unquote(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith("`") && text.endsWith("`"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function walkDeclarations(
  node: Node,
  classStack: readonly string[],
  spans: RawSpan[],
  imports: string[],
  exports: string[],
): void {
  if (node.type === "import_statement" || node.type === "import_from_statement") {
    const source = node.childForFieldName("source") ?? node.childForFieldName("module_name");
    if (source !== null) {
      imports.push(unquote(source.text));
    } else {
      for (const child of node.namedChildren) {
        if (child.type === "string") {
          imports.push(unquote(child.text));
        }
      }
    }
  }
  const parent = classStack[classStack.length - 1];
  const kind = kindForNode(node.type, parent);
  let nextStack = classStack;
  if (kind !== undefined) {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text ?? "anonymous";
    const isMethod = kind === "method";
    spans.push({
      kind,
      symbolId: isMethod && parent !== undefined ? `${parent}#${name}` : name,
      charStart: node.startIndex,
      charEnd: node.endIndex,
      imports,
      exports: kind === "class" || kind === "function" ? [name] : [],
      ...(parent !== undefined ? { parentSymbol: parent, parentClasses: [...classStack] } : {}),
    });
    if (kind === "function" || kind === "class") {
      exports.push(name);
    }
    if (kind === "class") {
      nextStack = [...classStack, name];
    }
  }
  for (const child of node.namedChildren) {
    walkDeclarations(child, nextStack, spans, imports, exports);
  }
}

async function languageFor(
  languageId: string,
  requestedPath: string | undefined,
): Promise<Language | undefined> {
  const bytes = resolvePinnedGrammarBytes(languageId, requestedPath);
  if (bytes === undefined) {
    return undefined;
  }
  const cacheKey = languageId;
  const cached = languageCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  await initTreeSitterRuntime();
  const loaded = await Language.load(bytes);
  languageCache.set(cacheKey, loaded);
  return loaded;
}

export async function enrichWithTreeSitter(input: {
  path: string;
  text: string;
  language: string;
  snapshotId: SnapshotId;
  category: string;
  grammarWasm?: Readonly<Record<string, string>>;
}): Promise<{ units: IndexUnit[]; producer: string; usedTreeSitter: boolean }> {
  const requested = input.grammarWasm?.[input.language];
  const language = await languageFor(input.language, requested);
  if (language === undefined) {
    return {
      units: chunkSource(input),
      producer: "pi-hec-structural-chunker/v1",
      usedTreeSitter: false,
    };
  }
  const started = Date.now();
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(input.text, null, {
    progressCallback: () => {
      if (Date.now() - started > INDEX_LIMITS.parseBudgetMs) {
        throw new LimitError(`tree-sitter parse ${input.path} exceeded CPU/time budget`);
      }
    },
  });
  try {
    assertWithinBudget(started, `tree-sitter ${input.path}`);
    if (tree === null) {
      return {
        units: chunkSource(input),
        producer: "pi-hec-structural-chunker/v1",
        usedTreeSitter: false,
      };
    }
    const imports: string[] = [];
    const exports: string[] = [];
    const spans: RawSpan[] = [];
    walkDeclarations(tree.rootNode, [], spans, imports, exports);
    if (input.language === "typescript" || input.language === "javascript") {
      const fromRe = /\b(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
      let match = fromRe.exec(input.text);
      while (match !== null) {
        const spec = match[1];
        if (spec !== undefined && match[0].includes("import") && !imports.includes(spec)) {
          imports.push(spec);
        }
        match = fromRe.exec(input.text);
      }
    }
    tree.delete();
    const units =
      spans.length === 0
        ? chunkSource(input).map((unit) => ({ ...unit, producer: "web-tree-sitter/0.26.13" }))
        : buildUnitsFromSpans(input, spans, "web-tree-sitter/0.26.13");
    return {
      units,
      producer: "web-tree-sitter/0.26.13",
      usedTreeSitter: true,
    };
  } finally {
    parser.delete();
  }
}
