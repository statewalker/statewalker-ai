// The plugin builder (statewalker/statewalker-root#82, #130): a plugin's native tools, built into
// the plugin bundle. Its scripts sit beside the tools' API in the extension directory:
//
//   dev.cellb.harness/tools/
//     openapi.json|yaml|yml      the tools' API: one script per operation, `<operationId>.ts|js|py`
//     <operationId>.ts|js|py     each default-exports `execute(input, ctx)` (Python: `def execute`)
//     <folder>/...               helpers the scripts import
//
// Without an OpenAPI file, the scripts are OpenCode-style tools: `<name>.ts|js` default-exports
// `{description, args, execute}`, and the builder generates the document from what each describes
// (`describe`, which runs the bundle in an isolate: only the host can). The build fails when
// scripts and operations don't match. TS and JS scripts are bundled by webrun-bundler into one
// self-contained ESM bundle per tool, `dev.cellb.harness/build/<tool>.js`, named by its sha-256 in
// the build manifest (`dev.cellb.harness/build/tools.json`); Python scripts are recorded as they
// are (they run once the code-execution ticket lands). Bare imports resolve from the plugin's own
// `node_modules` only: nothing is fetched. Workspace and project plugins' bundles pass the
// acceptance check (`accept`), which refuses any reach outside the language itself.
import { bundle, type Esbuild, nodeModulesPackages } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { parse as parseJs } from "acorn";
import { analyze } from "eslint-scope";
import { parse as parseYaml } from "yaml";
import { EXTENSION, hashFiles, type Plugin } from "./loader.js";
import { type JsonSchema, OPERATION_ID, operationIds } from "./tools.js";

const TOOLS_DIR = `${EXTENSION}/tools`;
/** Where the builder writes the bundles and their manifest. */
export const BUILD_DIR = `${EXTENSION}/build`;
export const BUILD_MANIFEST = `${BUILD_DIR}/tools.json`;

/** One built tool: a bundle (JS and TS) or its source as written (Python). */
export type ToolBuild =
  | { language: "js"; bundle: string; hash: string }
  | { language: "python"; source: string };

export interface BuildManifest {
  tools: Record<string, ToolBuild>;
}

/** What an OpenCode-style tool says of itself once evaluated: its description and input schema. */
export interface ToolDescription {
  description: string;
  args: JsonSchema;
}

export interface PluginBuilder {
  /** esbuild-wasm, initialized (or native esbuild on Node), or how to get it when first needed. */
  esbuild: Esbuild | (() => Promise<Esbuild>);
  /** Evaluates an OpenCode-style tool's bundle in an isolate; without it such tools fail the build. */
  describe?(code: string): Promise<ToolDescription>;
  /** Holds every bundle to the acceptance check (workspace and project plugins). */
  accept?: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

class BuildFailed extends Error {}

export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The top-level scripts of the tools folder, by tool name. */
function scriptsOf(plugin: Plugin): Map<string, { file: string; language: "js" | "python" }> {
  const out = new Map<string, { file: string; language: "js" | "python" }>();
  for (const path of [...plugin.files.keys()].sort()) {
    if (!path.startsWith(`${TOOLS_DIR}/`)) continue;
    const file = path.slice(TOOLS_DIR.length + 1);
    const m = /^([^/]+)\.(ts|js|mjs|py)$/.exec(file);
    if (!m) continue;
    const name = m[1] as string;
    if (out.has(name))
      throw new BuildFailed(`tool '${name}' has two scripts (${out.get(name)?.file}, ${file})`);
    out.set(name, { file, language: m[2] === "py" ? "python" : "js" });
  }
  return out;
}

function documentOf(plugin: Plugin): { path: string; doc: Record<string, unknown> } | undefined {
  for (const ext of ["json", "yaml", "yml"]) {
    const path = `${TOOLS_DIR}/openapi.${ext}`;
    const data = plugin.files.get(path);
    if (!data) continue;
    let doc: unknown;
    try {
      const text = dec.decode(data);
      doc = ext === "json" ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 0 });
    } catch {
      throw new BuildFailed(`openapi.${ext} does not parse`);
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
      throw new BuildFailed(`openapi.${ext} is not an object`);
    return { path, doc: doc as Record<string, unknown> };
  }
  return undefined;
}

/** One script bundled: self-contained ESM, no source map. */
async function bundleScript(
  files: MemFilesApi,
  name: string,
  file: string,
  builder: PluginBuilder,
): Promise<string> {
  let code: string;
  try {
    const esbuild =
      typeof builder.esbuild === "function" ? await builder.esbuild() : builder.esbuild;
    ({ code } = await bundle({
      esbuild,
      files,
      root: "/",
      entry: `/${TOOLS_DIR}/${file}`,
      packages: nodeModulesPackages(),
      format: "esm",
      platform: "neutral",
      conditions: ["worker", "browser"],
      target: "es2022",
      sourcemap: false,
    }));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split("\n")[0];
    throw new BuildFailed(`${name}: does not bundle: ${msg}`);
  }
  const problems = builder.accept ? acceptBundle(code) : importsOf(code);
  if (problems.length) throw new BuildFailed(`${name}: ${problems.join("; ")}`);
  return code;
}

/**
 * Builds a plugin's native tools into its bundle (see the top of this file). A plugin without tool
 * scripts or an OpenAPI file comes back as it is; one whose build fails, not at all.
 */
export async function buildPlugin(
  plugin: Plugin,
  builder: PluginBuilder,
): Promise<{ plugin?: Plugin; problems: string[] }> {
  try {
    const scripts = scriptsOf(plugin);
    const found = documentOf(plugin);
    if (!found && scripts.size === 0) return { plugin, problems: [] };
    const files = new MemFilesApi();
    for (const [path, data] of plugin.files) await files.write(`/${path}`, [data]);
    const out = new Map(plugin.files);
    for (const path of out.keys()) if (path.startsWith(`${BUILD_DIR}/`)) out.delete(path);
    const manifest: BuildManifest = { tools: {} };
    const addBundle = async (name: string, code: string) => {
      const bundlePath = `${BUILD_DIR}/${name}.js`;
      out.set(bundlePath, enc.encode(code));
      manifest.tools[name] = { language: "js", bundle: bundlePath, hash: await sha256(code) };
    };
    if (found) {
      const ops = operationIds(found.doc);
      const problems: string[] = [];
      for (const op of ops) {
        if (!OPERATION_ID.test(op))
          problems.push(`operationId '${op}' is not ${OPERATION_ID.source}`);
        else if (!scripts.has(op)) problems.push(`operation '${op}' has no script`);
      }
      for (const [name, s] of scripts)
        if (!ops.includes(name)) problems.push(`script '${s.file}' has no operation`);
      if (problems.length) throw new BuildFailed(problems.join("; "));
      for (const [name, s] of scripts) {
        if (s.language === "python")
          manifest.tools[name] = { language: "python", source: `${TOOLS_DIR}/${s.file}` };
        else await addBundle(name, await bundleScript(files, name, s.file, builder));
      }
    } else {
      // OpenCode-style tools: each one describes itself; the document is generated from that.
      const paths: Record<string, unknown> = {};
      for (const [name, s] of scripts) {
        if (!OPERATION_ID.test(name))
          throw new BuildFailed(`tool '${name}' is not named ${OPERATION_ID.source}`);
        if (s.language === "python")
          throw new BuildFailed(`${name}: a Python tool needs an OpenAPI file`);
        if (!builder.describe)
          throw new BuildFailed(`${name}: OpenCode-style tools need an isolate to describe them`);
        const code = await bundleScript(files, name, s.file, builder);
        let described: ToolDescription;
        try {
          described = await builder.describe(code);
        } catch (e) {
          throw new BuildFailed(`${name}: does not describe itself: ${(e as Error)?.message ?? e}`);
        }
        const args =
          described.args && typeof described.args === "object"
            ? described.args
            : { type: "object", properties: {} };
        paths[`/${name}`] = {
          post: {
            operationId: name,
            summary: String(described.description ?? ""),
            requestBody: { content: { "application/json": { schema: args } } },
          },
        };
        await addBundle(name, code);
      }
      out.set(
        `${TOOLS_DIR}/openapi.json`,
        enc.encode(
          `${JSON.stringify({ openapi: "3.1.0", info: { title: plugin.name, version: "1" }, paths }, null, 2)}\n`,
        ),
      );
    }
    out.set(BUILD_MANIFEST, enc.encode(`${JSON.stringify(manifest, null, 2)}\n`));
    return { plugin: { ...plugin, files: out, hash: await hashFiles(out) }, problems: [] };
  } catch (e) {
    if (!(e instanceof BuildFailed)) throw e;
    return { problems: [`${plugin.name}: tools: ${e.message}; not loaded`] };
  }
}

// --- the acceptance check -------------------------------------------------------------------------

/**
 * The globals a tool bundle may name: the language's own, and what the isolate gives every
 * Worker without reaching outside it (encoding, URLs, timers, crypto, structured cloning). Not
 * the global object, `eval`, `Function`, `fetch`, `WebAssembly`, or anything of the host's.
 */
const ALLOWED_GLOBALS = new Set([
  // values and functions
  "undefined",
  "NaN",
  "Infinity",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "encodeURI",
  "encodeURIComponent",
  "decodeURI",
  "decodeURIComponent",
  "escape",
  "unescape",
  // fundamental objects
  "Object",
  "Symbol",
  "Boolean",
  "Number",
  "BigInt",
  "Math",
  "Date",
  "String",
  "RegExp",
  "Array",
  "JSON",
  "Reflect",
  "Proxy",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Intl",
  "Atomics",
  // errors
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  // binary data
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  // the Worker's own, reaching nothing outside it
  "console",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "structuredClone",
  "atob",
  "btoa",
  "TextEncoder",
  "TextDecoder",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "Blob",
  "crypto",
  "performance",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "Event",
  "EventTarget",
  "DOMException",
  "Headers",
  "Request",
  "Response",
]);

/** Imports left in a bundle: it must be self-contained. */
function importsOf(code: string): string[] {
  try {
    const ast = parseJs(code, { ecmaVersion: "latest", sourceType: "module", ranges: true });
    return walkProblems(ast as unknown as Node);
  } catch (e) {
    return [`does not parse: ${(e as Error).message}`];
  }
}

interface Node {
  type: string;
  [key: string]: unknown;
}

function walkProblems(root: Node): string[] {
  const problems = new Set<string>();
  const walk = (n: unknown) => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (!n || typeof n !== "object" || typeof (n as Node).type !== "string") return;
    const node = n as Node;
    if (node.type === "ImportDeclaration")
      problems.add("imports a module (bundles are self-contained)");
    if (node.type === "ImportExpression") problems.add("uses dynamic import()");
    if (
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.source)
    )
      problems.add("re-exports a module (bundles are self-contained)");
    if (node.type === "MetaProperty") problems.add("uses import.meta");
    for (const [k, v] of Object.entries(node)) if (k !== "type") walk(v);
  };
  walk(root);
  return [...problems];
}

/**
 * The acceptance check of a workspace or project tool bundle (#82): it must parse, be
 * self-contained (no imports, no `import()`, no `import.meta`), and name no global outside the
 * language's own and the Worker's harmless ones (`ALLOWED_GLOBALS`). Answers the problems found.
 */
export function acceptBundle(code: string): string[] {
  let ast: Node;
  try {
    ast = parseJs(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      ranges: true,
    }) as unknown as Node;
  } catch (e) {
    return [`does not parse: ${(e as Error).message}`];
  }
  const problems = walkProblems(ast);
  const scope = analyze(ast as never, { ecmaVersion: 2022, sourceType: "module" });
  const global = scope.globalScope;
  const names = new Set<string>();
  for (const ref of global?.through ?? []) {
    const name = ref.identifier.name;
    if (!ALLOWED_GLOBALS.has(name)) names.add(name);
  }
  for (const name of [...names].sort()) problems.push(`names the global '${name}'`);
  return problems;
}
