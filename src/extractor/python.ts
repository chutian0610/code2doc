import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser, Query, Node as SyntaxNode } from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';
import { collectComments, fingerprintOf, spanOf } from './fingerprint.js';
import type { CommentRange } from './fingerprint.js';
import type { Extractor, FileRefs, ImportIndex, Span, SymbolKind, SymbolRecord } from './types.js';
import { claimCollector, noRefs, refCollector, symbolId } from './types.js';

/**
 * Python extractor: tree-sitter-python (WASM) behind the same Extractor
 * contract as TS/JS and Java. Parity rules, all pinned by unit tests:
 *
 * - Symbols are module-level only: `def`/`class` targets, plus assignments
 *   whose name is UPPER_CASE (the constants convention; kind: variable).
 *   Methods, nested defs and `if`-guarded blocks are not symbols, and
 *   assignments inside them never surface.
 * - Dunder names (`__all__`, `__version__`, …) are absent from the symbol
 *   surface: bookkeeping, not API.
 * - Visibility follows the underscore convention: a leading underscore
 *   (single or double, non-dunder) is internal; everything else public.
 *   `__all__`-driven visibility is a documented blind spot — dynamic
 *   construction makes half-support worse than none.
 * - Decorators sit inside the signature span: adding or removing one
 *   changes the interface (Broken), not the body.
 * - A constant splits the TS way: the name (and its annotation) are the
 *   signature, the value is the body — a value edit drifts a claim, an
 *   annotation edit breaks it. Signals stay at parity across languages.
 * - A same-name redefinition (legal Python; later binding wins at runtime)
 *   is one record per declaration; downstream the name key compares as a
 *   set (ADR-0006).
 * - Only `#` line comments are comments; docstrings are string statements
 *   and belong to the body — editing one drifts a claim, never breaks it.
 * - Call refs (ADR-0004): bare calls from module-level bodies and
 *   constant initializers; member calls only through a namespace
 *   binding (methods are not symbols here). Star imports, dynamic
 *   imports, decorator expressions and `super()` chains are documented
 *   blind spots — no edges, no false edges.
 */

const require = createRequire(import.meta.url);

const PYTHON_PKG_ROOT = path.dirname(require.resolve('tree-sitter-python/package.json'));
const PYTHON_WASM = path.join(PYTHON_PKG_ROOT, 'tree-sitter-python.wasm');

let parserInit: Promise<void> | undefined;
let languagePromise: Promise<Language> | undefined;

function getLanguage(): Promise<Language> {
  languagePromise ??= Language.load(PYTHON_WASM);
  return languagePromise;
}

/** Captures a declaration plus its name; the decl node drives span logic. */
const QUERY = `
  (function_definition name: (identifier) @name) @decl
  (class_definition name: (identifier) @name) @decl
  (assignment left: (identifier) @name) @decl
`;

/** Comment node shapes of the Python grammar: `#` line comments only. */
const COMMENT_QUERY = `(comment) @comment`;

/**
 * Call-ref sites per ADR-0004: bare calls by name and member calls —
 * Python has no `new`, and heritage is a base-list expression, not a
 * call site. Member calls are captured whole: the receiver chain is
 * decoded in code, and only a namespace binding claims the name (#26).
 */
const REF_QUERY = `
  (call function: (identifier) @callee)
  (call function: (attribute) @member)
`;

/** Whole import statements — the binding shapes are decoded here, not in a query. */
const IMPORT_QUERY = `
  (import_statement) @imp
  (import_from_statement) @imp
`;

/** tree-sitter node type → SymbolKind. */
const KINDS: Record<string, SymbolKind> = {
  function_definition: 'function',
  class_definition: 'class',
  assignment: 'variable',
};

/** `__all__` and friends: bookkeeping names that are never symbols. */
function isDunder(name: string): boolean {
  return name.startsWith('__') && name.endsWith('__') && name.length > 4;
}

/**
 * The constants convention: all caps, digits and underscores, one letter
 * at least. A leading underscore keeps the name a constant and marks it
 * internal (`_RATE = 0.5` is a private constant, still a symbol).
 */
function isUpperConstant(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name) && /[A-Z]/.test(name);
}

/** Visibility by the underscore convention (see the header comment). */
function visibilityOf(name: string): 'public' | 'internal' {
  return name.startsWith('_') ? 'internal' : 'public';
}

/**
 * The decorated_definition wrapper when present — its start is where the
 * signature begins, decorators included.
 */
function outerOf(decl: SyntaxNode): SyntaxNode {
  return decl.parent?.type === 'decorated_definition' ? decl.parent : decl;
}

/**
 * Module-level only. Assignments sit one `expression_statement` wrapper
 * below the module; defs, classes and decorated definitions are statements
 * in their own right.
 */
function isModuleLevel(outer: SyntaxNode): boolean {
  const parent = outer.parent;
  if (parent?.type === 'module') return true;
  return parent?.type === 'expression_statement' && parent.parent?.type === 'module';
}

/**
 * The header ends at its colon. The body block node starts after the
 * newline and indent — slicing at its start would fold that whitespace
 * into the signature.
 */
function headerEnd(decl: SyntaxNode, bodyNode: SyntaxNode | null): number {
  if (!bodyNode) return decl.endIndex;
  const colon = decl.children.find((c) => c.type === ':');
  return colon ? colon.endIndex : bodyNode.startIndex;
}

/** Parse a file once; extract and the later ref layers share the preamble. */
async function parseTree(code: string) {
  parserInit ??= Parser.init();
  await parserInit;
  const language = await getLanguage();
  const parser = new Parser();
  parser.setLanguage(language);
  return { language, tree: parser.parse(code) };
}

/**
 * The dotted text of a pure identifier chain (`pkg.mod`), or undefined
 * when the receiver is anything else — a call result (`super().x`), a
 * subscript. Only a chain an import statement could have bound is ours
 * to resolve; every other receiver names some runtime object's member,
 * and methods are not symbols in this language (#26).
 */
function dottedChain(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'attribute') {
    const base = dottedChain(node.childForFieldName('object'));
    const attr = node.childForFieldName('attribute')?.text;
    return base && attr ? `${base}.${attr}` : undefined;
  }
  return undefined;
}

/**
 * Attribute a ref site: calls belong to the enclosing module-level def,
 * or to the constant whose initializer holds them. A def always ends
 * the climb — a module-level def is the caller, while a method or
 * nested def is not a symbol and its body yields nothing; a class body
 * ends it too (attribute defaults, method bodies). A decorator
 * expression sits outside the def it decorates and yields nothing — a
 * tolerated missing edge.
 */
function callerOf(site: SyntaxNode): string | undefined {
  for (let cur = site.parent; cur; cur = cur.parent) {
    if (cur.type === 'function_definition') {
      return isModuleLevel(outerOf(cur))
        ? (cur.childForFieldName('name')?.text ?? undefined)
        : undefined;
    }
    if (cur.type === 'class_definition') return undefined;
    if (cur.type === 'assignment') {
      const outer = cur.parent?.type === 'expression_statement' ? cur.parent : cur;
      const left = cur.childForFieldName('left');
      // only the constants convention makes an assignment a symbol; a
      // lowercase module variable is no anchor target and claims nothing
      if (outer.parent?.type === 'module' && left?.type === 'identifier' && isUpperConstant(left.text)) {
        return left.text;
      }
      return undefined;
    }
  }
  return undefined;
}

/**
 * True when the called name is one of the enclosing def's parameters:
 * the call goes to whatever was passed in, so resolving it to an
 * import or a global of the same name would mint the false edge
 * ADR-0004 forbids. Rebinding a name inside the def body is a further
 * shadowing shape — a documented blind spot, not detectable without
 * ordering the statements.
 */
function shadowedByParameter(site: SyntaxNode, name: string): boolean {
  for (let cur = site.parent; cur; cur = cur.parent) {
    if (cur.type === 'function_definition') {
      const params = cur.childForFieldName('parameters');
      return !!params && params.descendantsOfType('identifier').some((p) => p.text === name);
    }
  }
  return false;
}

/**
 * A from-statement's module as a path: `pkg.mod` → `pkg/mod`; a
 * relative form keeps its dots against the file's own directory —
 * one dot means this package (`.` → `./__init__`), two the parent
 * (`..deep.pkg` → `../deep/pkg`).
 */
function moduleSourceOf(module: SyntaxNode): string {
  if (module.type === 'dotted_name') return module.text.replace(/\./g, '/');
  const dots = module.text.match(/^\.+/)?.[0].length ?? 1;
  const tail = module.text.slice(dots).replace(/\./g, '/');
  const ups = '..'.repeat(dots - 1);
  return `${ups ? `${ups}/` : './'}${tail || '__init__'}`;
}

/**
 * The claims pass: every import statement is a claim factory — a bound
 * name never falls through to same-file or global guesses
 * (ADR-0004/0005). `import pkg.mod` binds the dotted local name as a
 * namespace (member calls claim against the module's source; a
 * sibling of that module reached as `pkg.sibling` is a documented
 * blind spot); from-imports claim the imported name symbol-first
 * against the module, holding `<module>/<name>` for the
 * module-as-attribute shape (`from pkg import mod`, then
 * `mod.helper()`). A star import claims nothing — the names it would
 * bind are unknowable, and a guessed half-support is exactly the
 * false edge ADR-0004 forbids.
 */
function readImportClaims(language: Language, tree: Tree) {
  const claims = claimCollector();
  const { imports, namespaces } = claims;
  for (const { captures } of new Query(language, IMPORT_QUERY).matches(tree.rootNode)) {
    const imp = captures.find((c) => c.name === 'imp')?.node;
    if (!imp) continue;
    if (imp.type === 'import_statement') {
      for (const child of imp.namedChildren) {
        // dotted_name (plain) or aliased_import (`a.b as c`)
        const modulePath = child.type === 'aliased_import' ? child.childForFieldName('name')?.text : child.text;
        const local = child.type === 'aliased_import' ? child.childForFieldName('alias')?.text : child.text;
        if (!modulePath || !local) continue;
        namespaces.set(local, modulePath.replace(/\./g, '/'));
      }
      continue;
    }
    const module = imp.childForFieldName('module_name');
    if (!module) continue;
    const source = moduleSourceOf(module);
    for (const child of imp.namedChildren) {
      // the module itself is a child too; wildcard imports claim nothing
      if (child.id === module.id || child.type === 'relative_import' || child.type === 'wildcard_import') {
        continue;
      }
      const imported = child.type === 'aliased_import' ? child.childForFieldName('name')?.text : child.text;
      const local = child.type === 'aliased_import' ? child.childForFieldName('alias')?.text : child.text;
      if (!imported || !local) continue;
      imports[local] = { kind: 'named', imported, source };
      // the imported name may itself be a submodule (`from pkg import mod`)
      namespaces.set(local, `${source}/${imported}`);
    }
  }
  return claims;
}

/**
 * The calls pass: a member call's name is ours only through a
 * namespace binding — the receiver chain must be pure identifiers the
 * import table could have bound, and methods are not symbols here, so
 * every other member name is simply not reported (#26). A bare call
 * shadowed by a parameter of its enclosing def reports nothing — the
 * call goes to the argument, not to the name's import or global.
 */
function readCalls(language: Language, tree: Tree, claims: ReturnType<typeof claimCollector>): FileRefs['callers'] {
  const refs = refCollector();
  for (const { captures } of new Query(language, REF_QUERY).matches(tree.rootNode)) {
    const member = captures.find((c) => c.name === 'member')?.node;
    if (member) {
      const prop = member.childForFieldName('attribute')?.text;
      const base = dottedChain(member.childForFieldName('object'));
      if (!prop || !base) continue;
      if (!claims.claimViaNamespace(base, prop)) continue;
      refs.note(callerOf(member), prop);
      continue;
    }
    const callee = captures.find((c) => c.name === 'callee')?.node;
    if (!callee) continue;
    if (shadowedByParameter(callee, callee.text)) continue;
    refs.note(callerOf(callee), callee.text);
  }
  return refs.finish();
}

export function createPythonExtractor(): Extractor {
  return {
    languageId: 'python',
    extensions: ['.py'],
    async extract(code, file) {
      const { language, tree } = await parseTree(code);
      if (!tree) return [];
      const query = new Query(language, QUERY);
      const comments = collectComments(language, tree, COMMENT_QUERY);

      const records: SymbolRecord[] = [];
      for (const { captures } of query.matches(tree.rootNode)) {
        const decl = captures.find((c) => c.name === 'decl')?.node;
        const nameNode = captures.find((c) => c.name === 'name')?.node;
        if (!decl || !nameNode) continue;
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        // dunder names are bookkeeping, whatever the kind (PEP 562 makes
        // module-level `def __getattr__` real); assignments additionally
        // must read as constants — most assignments are module state
        if (isDunder(name)) continue;
        if (decl.type === 'assignment' && !isUpperConstant(name)) continue;
        const outer = outerOf(decl);
        if (!isModuleLevel(outer)) continue;

        // a constant splits like a TS variable (parity of signals, #32):
        // the name and its annotation are the signature, the value is the
        // body — a value edit drifts a claim, an annotation edit breaks it
        const bodyNode = decl.childForFieldName('body') ?? decl.childForFieldName('right');
        const signature: Span = {
          start: outer.startIndex,
          end:
            decl.type === 'assignment'
              ? bodyNode
                ? bodyNode.startIndex
                : decl.endIndex
              : headerEnd(decl, bodyNode),
          row: outer.startPosition.row,
          col: outer.startPosition.column,
        };
        const body = spanOf(bodyNode ?? decl);
        records.push({
          name,
          kind: KINDS[decl.type],
          file,
          signature,
          body,
          visibility: visibilityOf(name),
          fingerprint: fingerprintOf(code, signature, body, comments),
        });
      }
      return records;
    },
    async extractRefs(code) {
      const { language, tree } = await parseTree(code);
      if (!tree) return noRefs();
      const claims = readImportClaims(language, tree);
      return { imports: claims.imports, callers: readCalls(language, tree, claims) };
    },
    resolveImport(file, binding, index) {
      if (binding.kind !== 'named') return undefined;
      const { imported, source } = binding;
      if (source.startsWith('.')) {
        // relative form: exact paths against this file's own directory
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), source));
        const initPath = `${base}/__init__.py`;
        const target = index.at(initPath) !== undefined ? initPath : `${base}.py`;
        return index.at(target)?.includes(imported) ? symbolId(target, imported) : undefined;
      }
      // absolute dotted path: unique-suffix match per candidate, whatever
      // the package root (Java's package-path rule). A regular package
      // owns the name when it exists — Python resolves `pkg` to the
      // package directory before any same-named module file, and picking
      // the file would mint exactly the false edge ADR-0004 forbids
      const inits = index.matching(`${source}/__init__.py`);
      if (inits.length > 1) return undefined; // ambiguous across package roots
      if (inits.length === 1) {
        return index.at(inits[0])?.includes(imported) ? symbolId(inits[0], imported) : undefined;
      }
      const mods = index.matching(`${source}.py`);
      if (mods.length !== 1) return undefined; // external, or ambiguous
      return index.at(mods[0])?.includes(imported) ? symbolId(mods[0], imported) : undefined;
    },
  };
}
