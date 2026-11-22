// Tool definitions (statewalker/statewalker-root#90, built by #129). Every tool is one OpenAPI 3.1
// document in the harness's restricted profile:
//
//   - exactly one operation, `POST /tools/<plugin>/<tool>`;
//   - its JSON object request body is the tool's input schema, closed throughout
//     (`additionalProperties: false`), so providers' strict modes take it unchanged;
//   - its 200 JSON response is the output schema;
//   - everything else rides in the `x-dev.cellb.harness` extension: source, action (read, write,
//     admin), permission and route (how the harness reaches the real tool; never shown to a model).
//
// MCP tool entries and the agent loop's tools are always derived from the document, never stored.
// Documents come from three sources: the harness's own tools (built by the host), the operations of
// a plugin's `tools/openapi.json|yaml` (native tools, run as scripts: #130), and REST specs a
// plugin imports from `tools/rest/*.json|yaml` (path, query and header parameters flattened into
// one object, a non-object body wrapped as `body`, multipart operations left out, error responses
// becoming error results, auth schemes hidden: the route says where each argument goes, and the
// harness adds the key from the secrets).
import { codedError } from "@statewalker/ai-access";
import { type FilesApi, tryReadText } from "@statewalker/webrun-files";
import { parse } from "yaml";
import { EXTENSION, isPluginName } from "./loader.js";

/** The extension carrying what the harness knows of a tool. */
export const TOOL_EXTENSION = "x-dev.cellb.harness";

/** An operationId (#82): `<plugin>__<operationId>` then fits a provider's 64 characters. */
export const OPERATION_ID = /^[a-z][a-z0-9_]{0,47}$/;

/** What a tool does, which drives the mode: read tools are allowed where reads are. */
export type ToolAction = "read" | "write" | "admin";

export type ToolSource = "harness" | "native" | "rest" | "mcp";

export interface RestParam {
  name: string;
  in: "path" | "query" | "header";
}

/** Where the harness puts a REST tool's key: a placeholder the gateway resolves from secrets. */
export interface RestAuth {
  in: "header" | "query";
  name: string;
  /** The secret's name (`{{secret:<secret>}}`). */
  secret: string;
  /** Written before the key (`Bearer `). */
  prefix?: string;
}

/** How the harness reaches the real tool. Never shown to a model. */
export type ToolRoute =
  | { kind: "harness"; entry: string }
  | {
      kind: "native";
      /** The tool's operationId. */
      entry: string;
      /** How the builder recorded its script (#130): a JS bundle, or Python source. */
      language?: "js" | "python";
      /** The bundle's path in the plugin (JS), or the script's (Python). */
      bundle?: string;
      /** The bundle's sha-256. */
      hash?: string;
    }
  | { kind: "mcp"; url: string; name: string }
  | {
      kind: "rest";
      method: string;
      /** The server's URL and the operation's path template. */
      url: string;
      params: RestParam[];
      /** The body: the input's other properties (`object`), or its `body` property (`wrapped`). */
      body?: "object" | "wrapped";
      auth?: RestAuth;
    };

export interface ToolExtension {
  /** `<plugin>/<tool>`. */
  id: string;
  /** The projected name: `<plugin>__<tool>`, `[A-Za-z0-9_-]`, at most 64 characters. */
  name: string;
  source: ToolSource;
  plugin: string;
  tool: string;
  action: ToolAction;
  /** The permission a role grants to use it (`tools.use:<plugin>/<tool>` by default). */
  permission: string;
  route: ToolRoute;
}

export type JsonSchema = Record<string, unknown>;

interface ProfileOperation {
  operationId: string;
  summary: string;
  requestBody: { required: true; content: { "application/json": { schema: JsonSchema } } };
  responses: {
    200: { description: string; content: { "application/json": { schema: JsonSchema } } };
    default: { description: string };
  };
}

/** One tool, as one OpenAPI 3.1 document in the restricted profile. */
export interface ToolDefinition {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  paths: Record<string, { post: ProfileOperation }>;
  [TOOL_EXTENSION]: ToolExtension;
}

// --- names and schemas ----------------------------------------------------------------------------

const MAX_NAME = 64;

/** FNV-1a, 32 bits, as 8 hex digits: a long name's stable suffix. */
function hash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The name a model and an MCP client see: `<plugin>__<tool>` in letters, digits, `_` and `-`; over
 * 64 characters, cut and suffixed with a hash of the whole, so it stays unique and stable.
 */
export function toolName(plugin: string, tool: string): string {
  const raw = `${plugin}__${tool}`;
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (safe.length <= MAX_NAME) return safe;
  return `${safe.slice(0, MAX_NAME - 9)}_${hash32(raw)}`;
}

/** Every object schema closed (`additionalProperties: false` where it says nothing), recursively. */
export function closedSchema(schema: unknown): JsonSchema {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== "object") return s;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) o[k] = walk(v);
    if (o.type === "object" && o.additionalProperties === undefined) o.additionalProperties = false;
    return o;
  };
  const out = walk(schema ?? {}) as JsonSchema;
  return out.type === "object"
    ? out
    : { type: "object", properties: {}, additionalProperties: false };
}

/** `$ref`s to the document's components replaced by what they name (depth-limited: no cycles). */
function inlined(schema: unknown, doc: Record<string, unknown>): unknown {
  const walk = (s: unknown, depth: number): unknown => {
    if (depth > 24) return {};
    if (Array.isArray(s)) return s.map((x) => walk(x, depth + 1));
    if (!s || typeof s !== "object") return s;
    const ref = (s as { $ref?: unknown }).$ref;
    if (typeof ref === "string") {
      if (!ref.startsWith("#/")) return {};
      let at: unknown = doc;
      for (const seg of ref.slice(2).split("/"))
        at = (at as Record<string, unknown> | undefined)?.[
          seg.replace(/~1/g, "/").replace(/~0/g, "~")
        ];
      return walk(at ?? {}, depth + 1);
    }
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, walk(v, depth + 1)]));
  };
  return walk(schema, 0);
}

// --- the profile ----------------------------------------------------------------------------------

/** Builds a tool's document in the restricted profile. */
export function toolDefinition(p: {
  plugin: string;
  tool: string;
  source: ToolSource;
  description: string;
  action: ToolAction;
  input?: JsonSchema;
  output?: JsonSchema;
  permission?: string;
  route: ToolRoute;
  /** The projected name, when it isn't `<plugin>__<tool>` (the harness's own tools). */
  name?: string;
}): ToolDefinition {
  const id = `${p.plugin}/${p.tool}`;
  const name = p.name ?? toolName(p.plugin, p.tool);
  return {
    openapi: "3.1.0",
    info: { title: id, version: "1", description: p.description },
    paths: {
      [`/tools/${id}`]: {
        post: {
          operationId: name,
          summary: p.description,
          requestBody: {
            required: true,
            content: { "application/json": { schema: closedSchema(p.input) } },
          },
          responses: {
            200: {
              description: "The tool's result",
              content: { "application/json": { schema: p.output ?? {} } },
            },
            default: { description: "The tool failed, or the call was refused" },
          },
        },
      },
    },
    [TOOL_EXTENSION]: {
      id,
      name,
      source: p.source,
      plugin: p.plugin,
      tool: p.tool,
      action: p.action,
      permission: p.permission ?? `tools.use:${id}`,
      route: p.route,
    },
  };
}

const operationOf = (d: ToolDefinition): ProfileOperation | undefined =>
  Object.values(d.paths)[0]?.post;

/** A tool's input schema: a closed object. */
export const toolInput = (d: ToolDefinition): JsonSchema =>
  closedSchema(operationOf(d)?.requestBody.content["application/json"].schema);

/** A tool's output schema, if it declares one. */
export function toolOutput(d: ToolDefinition): JsonSchema | undefined {
  const s = operationOf(d)?.responses[200].content["application/json"].schema;
  return s && typeof s === "object" && Object.keys(s).length ? s : undefined;
}

/** What the harness knows of a tool. */
export const toolExtension = (d: ToolDefinition): ToolExtension => d[TOOL_EXTENSION];

/** An entry of MCP `tools/list`. */
export function toMcpTool(d: ToolDefinition) {
  const x = d[TOOL_EXTENSION];
  const output = toolOutput(d);
  return {
    name: x.name,
    title: d.info.title,
    description: d.info.description,
    inputSchema: toolInput(d),
    ...(output ? { outputSchema: output } : {}),
    annotations: {
      readOnlyHint: x.action === "read",
      destructiveHint: x.action === "admin",
      openWorldHint: x.source === "rest" || x.source === "mcp",
    },
  };
}

// --- conversion from OpenAPI operations -----------------------------------------------------------

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const ACTIONS: readonly ToolAction[] = ["read", "write", "admin"];

type Operation = {
  operationId?: unknown;
  summary?: unknown;
  description?: unknown;
  parameters?: unknown;
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  [TOOL_EXTENSION]?: { action?: unknown };
};

type Parameter = {
  name?: unknown;
  in?: unknown;
  required?: unknown;
  schema?: unknown;
  description?: unknown;
};

/** An imported operation's id as an operationId of the profile: snake_case, at most 48. */
function snakeId(op: Operation, method: string, path: string): string | undefined {
  const raw =
    typeof op.operationId === "string" && op.operationId ? op.operationId : `${method}_${path}`;
  const id = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 48)
    .replace(/_+$/, "");
  return OPERATION_ID.test(id) ? id : undefined;
}

interface Converted {
  input: JsonSchema;
  output?: JsonSchema;
  params: RestParam[];
  body?: "object" | "wrapped";
  description: string;
  action: ToolAction;
}

/** One operation's input, flattened; undefined for one with no JSON form (multipart). */
function convert(
  op: Operation,
  method: string,
  doc: Record<string, unknown>,
  pathParams: unknown,
): Converted | undefined {
  const content = op.requestBody?.content ?? {};
  const json = content["application/json"]?.schema;
  if (!json && Object.keys(content).length > 0) return undefined;
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  const params: RestParam[] = [];
  const all = [
    ...(Array.isArray(pathParams) ? pathParams : []),
    ...(Array.isArray(op.parameters) ? op.parameters : []),
  ].map((p) => inlined(p, doc) as Parameter);
  const seen = new Set<string>();
  for (const p of all.reverse()) {
    // Operation parameters override the path item's; cookies have no place in a call.
    if (typeof p?.name !== "string" || (p.in !== "path" && p.in !== "query" && p.in !== "header"))
      continue;
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    params.unshift({ name: p.name, in: p.in });
    const schema = (inlined(p.schema, doc) as JsonSchema | undefined) ?? { type: "string" };
    props[p.name] = {
      ...schema,
      ...(typeof p.description === "string" ? { description: p.description } : {}),
    };
    if (p.required === true || p.in === "path") required.unshift(p.name);
  }
  let body: Converted["body"];
  if (json) {
    const schema = inlined(json, doc) as JsonSchema;
    if (schema.type === "object") {
      for (const [k, v] of Object.entries((schema.properties ?? {}) as Record<string, unknown>))
        if (!(k in props)) props[k] = v;
      for (const r of (schema.required ?? []) as unknown[])
        if (typeof r === "string" && !required.includes(r)) required.push(r);
      body = "object";
    } else {
      props.body = schema;
      required.push("body");
      body = "wrapped";
    }
  }
  const ok = Object.entries(op.responses ?? {}).find(([code]) => /^2/.test(code));
  const out = ok?.[1]?.content?.["application/json"]?.schema;
  const declared = op[TOOL_EXTENSION]?.action;
  return {
    input: { type: "object", properties: props, ...(required.length ? { required } : {}) },
    ...(out ? { output: inlined(out, doc) as JsonSchema } : {}),
    params,
    ...(body ? { body } : {}),
    description: String(op.summary ?? op.description ?? ""),
    action: ACTIONS.includes(declared as ToolAction)
      ? (declared as ToolAction)
      : method === "get" || method === "head"
        ? "read"
        : "write",
  };
}

/** The operations of a document: method, path, path item parameters and the operation. */
function* operations(doc: Record<string, unknown>) {
  const paths = doc.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths || typeof paths !== "object") return;
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (op && typeof op === "object") yield { method, path, op, pathParams: item.parameters };
    }
  }
}

/** The operationIds a document declares, in order (whether valid or not). */
export function operationIds(doc: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const { op } of operations(doc))
    if (typeof op.operationId === "string" && !out.includes(op.operationId))
      out.push(op.operationId);
  return out;
}

/** A built tool as the builder's manifest records it (see builder.ts). */
export type NativeBuild =
  | { language: "js"; bundle: string; hash: string }
  | { language: "python"; source: string };

/**
 * The tools of a plugin's `tools/openapi` document: one native tool per operation, its route
 * naming the bundle the builder made for it (`builds`, the build manifest's tools).
 */
export function nativeTools(
  plugin: string,
  doc: Record<string, unknown>,
  builds: Record<string, NativeBuild> = {},
): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const { method, op, pathParams } of operations(doc)) {
    const id = op.operationId;
    if (typeof id !== "string" || !OPERATION_ID.test(id) || seen.has(id)) continue;
    const c = convert(op, method, doc, pathParams);
    if (!c) continue;
    seen.add(id);
    out.push(
      toolDefinition({
        plugin,
        tool: id,
        source: "native",
        description: c.description || id,
        action: c.action,
        input: c.input,
        ...(c.output ? { output: c.output } : {}),
        route: { kind: "native", entry: id, ...buildRoute(builds[id]) },
      }),
    );
  }
  return out;
}

function buildRoute(b: NativeBuild | undefined) {
  if (b?.language === "js") return { language: "js" as const, bundle: b.bundle, hash: b.hash };
  if (b?.language === "python") return { language: "python" as const, bundle: b.source };
  return {};
}

/** The secret a plugin's key is in when its scheme names none: `<PLUGIN>_API_KEY`. */
const defaultSecret = (plugin: string) =>
  `${plugin.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

/** The first key scheme the document's security asks for, as the harness adds it. */
function authOf(plugin: string, doc: Record<string, unknown>, op: Operation): RestAuth | undefined {
  const schemes = ((doc.components as Record<string, unknown> | undefined)?.securitySchemes ??
    {}) as Record<string, Record<string, unknown>>;
  const required = ((op as { security?: unknown }).security ?? doc.security) as
    | Record<string, unknown>[]
    | undefined;
  const names = Array.isArray(required)
    ? required.flatMap((r) => Object.keys(r ?? {}))
    : Object.keys(schemes);
  for (const name of names) {
    const s = inlined(schemes[name], doc) as Record<string, unknown> | undefined;
    if (!s) continue;
    const ext = s[TOOL_EXTENSION] as { secret?: unknown } | undefined;
    const secret =
      typeof ext?.secret === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ext.secret)
        ? ext.secret
        : defaultSecret(plugin);
    if (
      s.type === "apiKey" &&
      (s.in === "header" || s.in === "query") &&
      typeof s.name === "string"
    )
      return { in: s.in, name: s.name, secret };
    if (s.type === "http" && String(s.scheme).toLowerCase() === "bearer")
      return { in: "header", name: "Authorization", secret, prefix: "Bearer " };
  }
  return undefined;
}

/**
 * The tools of an imported REST spec (OpenAPI 3.x): one per operation with a JSON (or no) body,
 * operationIds made snake_case, parameters flattened, auth hidden, the route kept.
 */
export function restTools(plugin: string, doc: Record<string, unknown>): ToolDefinition[] {
  const server = (doc.servers as { url?: unknown }[] | undefined)?.[0]?.url;
  const base = typeof server === "string" ? server.replace(/\/+$/, "") : "";
  if (!/^https?:\/\//i.test(base)) return [];
  const out: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const { method, path, op, pathParams } of operations(doc)) {
    const id = snakeId(op, method, path);
    if (!id || seen.has(id)) continue;
    const c = convert(op, method, doc, pathParams);
    if (!c) continue;
    seen.add(id);
    const auth = authOf(plugin, doc, op);
    out.push(
      toolDefinition({
        plugin,
        tool: id,
        source: "rest",
        description: c.description || `${method.toUpperCase()} ${path}`,
        action: c.action,
        input: c.input,
        ...(c.output ? { output: c.output } : {}),
        route: {
          kind: "rest",
          method: method.toUpperCase(),
          url: `${base}${path}`,
          params: c.params,
          ...(c.body ? { body: c.body } : {}),
          ...(auth ? { auth } : {}),
        },
      }),
    );
  }
  return out;
}

const PLACEHOLDER = /\{\{\s*secret\s*:/i;

/** An argument's value as text, for a path, a query or a header. */
const textOf = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * The HTTP request a REST tool's call is rebuilt into: path parameters encoded into the path, the
 * query, the model's headers, the body, and the key's placeholder, which only the gateway resolves
 * (the model's values are encoded or refused, so they never name a secret). EINVAL for a missing
 * required argument or a header value naming a secret.
 */
export function restRequest(
  d: ToolDefinition,
  args: Record<string, unknown>,
): { method: string; url: string; headers: Record<string, string>; body?: string } {
  const route = d[TOOL_EXTENSION].route;
  if (route.kind !== "rest")
    throw codedError("EINVAL", `${d[TOOL_EXTENSION].name} is not a REST tool`);
  const input = toolInput(d);
  for (const r of (input.required ?? []) as string[])
    if (args[r] === undefined || args[r] === null)
      throw codedError("EINVAL", `the argument '${r}' is required`);
  let url = route.url;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  for (const p of route.params) {
    const v = args[p.name];
    if (v === undefined || v === null) {
      if (p.in === "path") throw codedError("EINVAL", `the argument '${p.name}' is required`);
      continue;
    }
    const text = textOf(v);
    if (p.in === "path") {
      // `.`, `..` or nothing would make URL normalization leave the route's path.
      if (text === "" || text === "." || text === "..")
        throw codedError("EINVAL", `the path argument '${p.name}' cannot be '${text}'`);
      url = url.split(`{${p.name}}`).join(encodeURIComponent(text));
    } else if (p.in === "query") query.append(p.name, text);
    else {
      if (PLACEHOLDER.test(text) || /[\r\n]/.test(text))
        throw codedError(
          "EINVAL",
          `the header '${p.name}' cannot name a secret or hold a line break`,
        );
      headers[p.name] = text;
    }
  }
  let body: string | undefined;
  if (route.body === "wrapped") body = JSON.stringify(args.body);
  else if (route.body === "object") {
    const named = new Set(route.params.map((p) => p.name));
    const declared = Object.keys((input.properties ?? {}) as object).filter((k) => !named.has(k));
    body = JSON.stringify(
      Object.fromEntries(declared.filter((k) => args[k] !== undefined).map((k) => [k, args[k]])),
    );
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  let qs = query.toString();
  if (route.auth) {
    // The key's placeholder goes in as written: only the gateway resolves it.
    const value = `${route.auth.prefix ?? ""}{{secret:${route.auth.secret}}}`;
    if (route.auth.in === "header") headers[route.auth.name] = value;
    else qs = [qs, `${encodeURIComponent(route.auth.name)}=${value}`].filter(Boolean).join("&");
  }
  if (qs) url += `${url.includes("?") ? "&" : "?"}${qs}`;
  // The rebuilt request stays on the route's path: as many segments as its template.
  const segments = (u: string) => new URL(u).pathname.split("/").length;
  if (segments(url) !== segments(route.url.replace(/\{[^}]*\}/g, "x")))
    throw codedError("EINVAL", `the call would leave the route of ${d[TOOL_EXTENSION].name}`);
  return { method: route.method, url, headers, ...(body !== undefined ? { body } : {}) };
}

// --- a catalog's tools ----------------------------------------------------------------------------

async function readDoc(
  catalog: FilesApi,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  const text = await tryReadText(catalog, path);
  if (text === undefined) return undefined;
  try {
    const doc = path.endsWith(".json") ? JSON.parse(text) : parse(text, { maxAliasCount: 0 });
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

async function pluginsOf(catalog: FilesApi): Promise<string[]> {
  const out: string[] = [];
  if ((await catalog.stats("/"))?.kind !== "directory") return out;
  for await (const e of catalog.list("/"))
    if (
      e.kind === "directory" &&
      isPluginName(e.name) &&
      (await catalog.exists(`/${e.name}/plugin.json`))
    )
      out.push(e.name);
  return out.sort();
}

/** The tools of one plugin of a catalog: its `tools/openapi` operations, then its REST imports. */
async function pluginTools(catalog: FilesApi, plugin: string): Promise<ToolDefinition[]> {
  const dir = `/${plugin}/${EXTENSION}/tools`;
  const out: ToolDefinition[] = [];
  for (const ext of ["json", "yaml", "yml"]) {
    const doc = await readDoc(catalog, `${dir}/openapi.${ext}`);
    if (!doc) continue;
    const manifest = await readDoc(catalog, `/${plugin}/${EXTENSION}/build/tools.json`);
    const builds = (manifest?.tools ?? {}) as Record<string, NativeBuild>;
    out.push(...nativeTools(plugin, doc, builds));
    break;
  }
  const rest = `${dir}/rest`;
  if ((await catalog.stats(rest))?.kind === "directory") {
    const files: string[] = [];
    for await (const e of catalog.list(rest))
      if (e.kind === "file" && /\.(json|ya?ml)$/.test(e.name)) files.push(e.name);
    for (const file of files.sort()) {
      const doc = await readDoc(catalog, `${rest}/${file}`);
      if (doc) out.push(...restTools(plugin, doc));
    }
  }
  // One tool per name: the first wins (an operation, then the imports in file order).
  const seen = new Set<string>();
  return out.filter((d) => !seen.has(d[TOOL_EXTENSION].tool) && seen.add(d[TOOL_EXTENSION].tool));
}

/** Every tool a catalog's plugins define, as documents in the restricted profile, by id. */
export async function catalogToolDefinitions(catalog: FilesApi): Promise<ToolDefinition[]> {
  const out: ToolDefinition[] = [];
  for (const plugin of await pluginsOf(catalog)) out.push(...(await pluginTools(catalog, plugin)));
  return out.sort((a, b) => {
    const x = a[TOOL_EXTENSION].id;
    const y = b[TOOL_EXTENSION].id;
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
