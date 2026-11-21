// The plugin loader (statewalker/statewalker-root#82): reads plugin sources in their own layouts
// and writes them into a catalog FilesApi in the standard layout, Agent Plugins 1.0 with the
// harness's extras in its extension directory:
//
//   <plugin>/
//     plugin.json                 Agent Plugins 1.0 manifest
//     skills/<skill>/SKILL.md     (and the skill's other files)
//     mcp.json                    remote MCP servers
//     dev.cellb.harness/
//       agents/<agent>.md         front matter + instructions
//       tools/...                 the tools' OpenAPI file and scripts (built by a later ticket)
//
// It reads Agent Plugins 1.0 sources (a root `plugin.json` naming the 1.0 or 1.1 schema) and
// Claude Code plugins (`.claude-plugin/plugin.json`, optional, with `agents/`, `skills/` and
// `.mcp.json`), converted the way OpenAI's and Copilot's loaders do. Other layouts: #102.
import type { FilesApi } from "@statewalker/webrun-files";
import { formatFrontMatter, parseFrontMatter } from "./front-matter.js";

export const AGENT_PLUGINS_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const ACCEPTED_SCHEMAS = [
  AGENT_PLUGINS_SCHEMA,
  "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
];
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
/** The harness's extension directory in a plugin. */
export const EXTENSION = "dev.cellb.harness";

/** Limits that keep one plugin within what a catalog row and a session start can carry. */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_PLUGIN_BYTES = 16 * 1024 * 1024;
export const MAX_PLUGIN_FILES = 2000;

/** A plugin name (Agent Plugins §3): a-z 0-9 - ., alphanumeric at both ends, no `--` or `..`. */
const PLUGIN_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
/** A skill or agent name: a-z 0-9 -, alphanumeric at both ends, no `--`. */
const ITEM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const isPluginName = (n: string) => PLUGIN_NAME.test(n) && !/--|\.\./.test(n);
export const isItemName = (n: string) => ITEM_NAME.test(n) && !n.includes("--");

/** A plugin in the standard layout: its files by path relative to the plugin's root. */
export interface Plugin {
  name: string;
  /** sha-256 (hex) of its files in the standard layout. */
  hash: string;
  /** The layout it was read from. */
  layout: "agent-plugins" | "claude-code";
  files: Map<string, Uint8Array>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (v: unknown) => enc.encode(`${JSON.stringify(v, null, 2)}\n`);

class Rejected extends Error {}

async function bytesOf(fs: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of fs.read(path)) {
    size += chunk.length;
    if (size > MAX_FILE_BYTES) throw new Rejected(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
    parts.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const isFile = async (fs: FilesApi, path: string) => (await fs.stats(path))?.kind === "file";
const isDir = async (fs: FilesApi, path: string) => (await fs.stats(path))?.kind === "directory";

/** Every file under a directory, by path relative to it. */
async function filesUnder(fs: FilesApi, dir: string): Promise<string[]> {
  const out: string[] = [];
  if (!(await isDir(fs, dir))) return out;
  for await (const e of fs.list(dir, { recursive: true }))
    if (e.kind === "file") out.push(e.path.slice(dir.length + 1));
  return out.sort();
}

async function children(fs: FilesApi, dir: string, kind: "file" | "directory") {
  const out: string[] = [];
  if (!(await isDir(fs, dir))) return out;
  for await (const e of fs.list(dir)) if (e.kind === kind) out.push(e.name);
  return out.sort();
}

/** sha-256 of a plugin's files, in path order: each path, its length and its bytes. */
export async function hashFiles(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path) as Uint8Array;
    parts.push(enc.encode(`${path}\0${data.length}\0`), data);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Collects a plugin's files, holding them to the limits. */
class Builder {
  readonly files = new Map<string, Uint8Array>();
  #size = 0;
  constructor(
    readonly name: string,
    readonly problems: string[],
  ) {}
  add(path: string, data: Uint8Array) {
    if (!this.files.has(path)) {
      if (this.files.size >= MAX_PLUGIN_FILES)
        throw new Rejected(`more than ${MAX_PLUGIN_FILES} files`);
      this.#size += data.length;
      if (this.#size > MAX_PLUGIN_BYTES)
        throw new Rejected(`larger than ${MAX_PLUGIN_BYTES} bytes`);
    }
    this.files.set(path, data);
  }
  problem(text: string) {
    this.problems.push(`${this.name}: ${text}`);
  }
}

const MANIFEST_FIELDS = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
] as const;

/** The manifest's fields that are kept, checked as the Agent Plugins schema has them. */
function manifestFields(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["version", "description", "homepage", "license"] as const) {
    if (m[key] === undefined) continue;
    if (typeof m[key] !== "string") throw new Rejected(`manifest field '${key}' is not a string`);
    out[key] = m[key];
  }
  if (m.author !== undefined) {
    const a = m.author as Record<string, unknown>;
    if (!a || typeof a !== "object" || Array.isArray(a) || typeof a.name !== "string")
      throw new Rejected("manifest field 'author' is not {name, email?, url?}");
    out.author = Object.fromEntries(
      (["name", "email", "url"] as const)
        .filter((k) => typeof a[k] === "string")
        .map((k) => [k, a[k]]),
    );
  }
  if (m.repository !== undefined) {
    if (typeof m.repository === "string") out.repository = m.repository;
    else if (
      m.repository &&
      typeof m.repository === "object" &&
      typeof (m.repository as { url?: unknown }).url === "string"
    )
      out.repository = m.repository;
    else throw new Rejected("manifest field 'repository' is not a string or {url}");
  }
  if (m.keywords !== undefined) {
    if (!Array.isArray(m.keywords) || m.keywords.some((k) => typeof k !== "string"))
      throw new Rejected("manifest field 'keywords' is not a list of strings");
    out.keywords = m.keywords;
  }
  return out;
}

async function readJson(fs: FilesApi, path: string): Promise<Record<string, unknown>> {
  let v: unknown;
  try {
    v = JSON.parse(dec.decode(await bytesOf(fs, path)));
  } catch (e) {
    if (e instanceof Rejected) throw e;
    throw new Rejected(`${path.split("/").pop()} is not JSON`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Rejected(`${path.split("/").pop()} is not a JSON object`);
  return v as Record<string, unknown>;
}

/** Copies each skill folder (an immediate child of `dir` holding a SKILL.md). */
async function addSkills(fs: FilesApi, dir: string, b: Builder) {
  for (const skill of await children(fs, dir, "directory")) {
    const root = join(dir, skill);
    if (!(await isFile(fs, join(root, "SKILL.md")))) continue;
    if (!isItemName(skill)) {
      b.problem(`skill '${skill}' is not a valid name; skipped`);
      continue;
    }
    for (const rel of await filesUnder(fs, root))
      b.add(`skills/${skill}/${rel}`, await bytesOf(fs, join(root, rel)));
  }
}

/** `mcp.json` in the standard form; Claude Code's `http` transport is Streamable HTTP. */
function mcpOf(servers: Record<string, unknown>, b: Builder): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      b.problem(`MCP server '${name}' is not an object; skipped`);
      continue;
    }
    const server = { ...(raw as Record<string, unknown>) };
    if (server.type === "http") server.type = "streamable-http";
    if (server.type === undefined && typeof server.command === "string") server.type = "stdio";
    out[name] = server;
  }
  return out;
}

/** An agent file, checked: its name is the file's, and its front matter parses. */
function checkedAgent(name: string, data: Uint8Array, b: Builder): boolean {
  if (!isItemName(name)) {
    b.problem(`agent '${name}' is not a valid name; skipped`);
    return false;
  }
  try {
    parseFrontMatter(dec.decode(data));
    return true;
  } catch (e) {
    b.problem(`agent '${name}': ${(e as Error).message}; skipped`);
    return false;
  }
}

async function readAgentPlugin(
  fs: FilesApi,
  dir: string,
  manifest: Record<string, unknown>,
  b: Builder,
) {
  for (const key of Object.keys(manifest))
    if (!(MANIFEST_FIELDS as readonly string[]).includes(key) && key !== "displayName")
      b.problem(`unknown manifest field '${key}'; ignored`);
  b.add(
    "plugin.json",
    json({ $schema: manifest.$schema, name: b.name, ...manifestFields(manifest) }),
  );
  await addSkills(fs, join(dir, "skills"), b);
  if (await isFile(fs, join(dir, "mcp.json"))) {
    const mcp = await readJson(fs, join(dir, "mcp.json"));
    const servers = (mcp.mcpServers ?? {}) as Record<string, unknown>;
    b.add("mcp.json", json({ $schema: MCP_SCHEMA, mcpServers: mcpOf(servers, b) }));
  }
  const ext = join(dir, EXTENSION);
  for (const file of await children(fs, join(ext, "agents"), "file")) {
    if (!file.endsWith(".md")) continue;
    const data = await bytesOf(fs, join(ext, `agents/${file}`));
    if (checkedAgent(file.slice(0, -3), data, b)) b.add(`${EXTENSION}/agents/${file}`, data);
  }
  for (const rel of await filesUnder(fs, join(ext, "tools")))
    b.add(`${EXTENSION}/tools/${rel}`, await bytesOf(fs, join(ext, `tools/${rel}`)));
}

/** A `./`-relative path in a Claude Code manifest, resolved inside the plugin's root. */
function inside(dir: string, rel: unknown, b: Builder): string | undefined {
  if (typeof rel !== "string") return undefined;
  const parts: string[] = [];
  for (const seg of rel.replace(/^\.\//, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.pop()) {
        b.problem(`path '${rel}' leaves the plugin; ignored`);
        return undefined;
      }
    } else parts.push(seg);
  }
  return parts.length ? `${dir}/${parts.join("/")}` : dir;
}

const listOf = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Claude Code's own tool names (Read, Bash, …): Flue's file and shell tools stand for them. */
const CLAUDE_BUILT_IN = /^[A-Z][A-Za-z]*(?:\(.*\))?$/;

/** A Claude Code agent's front matter in the harness's terms. */
function convertClaudeAgent(data: Record<string, unknown>, plugin: string) {
  const out: Record<string, unknown> = {};
  if (typeof data.description === "string") out.description = data.description;
  if (typeof data.model === "string" && data.model !== "inherit") out.models = [data.model];
  if (data.skills !== undefined) {
    const skills = typeof data.skills === "string" ? data.skills.split(",") : listOf(data.skills);
    out.skills = skills.map((s) => String(s).trim()).filter(Boolean);
  }
  // Claude Code agents without `tools` inherit every tool; with it, Claude's own tools are Flue's,
  // always there, and its MCP tools are this plugin's.
  if (data.tools === undefined) out.tools = ["*"];
  else {
    const tools = (typeof data.tools === "string" ? data.tools.split(",") : listOf(data.tools))
      .map((t) => String(t).trim())
      .filter(Boolean);
    const kept = tools.filter((t) => !CLAUDE_BUILT_IN.test(t) && !t.startsWith("mcp__"));
    if (tools.some((t) => t.startsWith("mcp__"))) kept.push(`${plugin}/*`);
    out.tools = kept;
  }
  return out;
}

async function readClaudePlugin(
  fs: FilesApi,
  dir: string,
  manifest: Record<string, unknown>,
  b: Builder,
) {
  b.add(
    "plugin.json",
    json({ $schema: AGENT_PLUGINS_SCHEMA, name: b.name, ...manifestFields(manifest) }),
  );
  // Skills: `skills/` plus the manifest's folders (each a skill, or a folder of skills).
  await addSkills(fs, join(dir, "skills"), b);
  for (const rel of listOf(manifest.skills)) {
    const path = inside(dir, rel, b);
    if (!path) continue;
    if (await isFile(fs, join(path, "SKILL.md")))
      await addSkills(fs, path.slice(0, path.lastIndexOf("/")) || "/", b);
    else await addSkills(fs, path, b);
  }
  // Agents: the manifest's files or folders replace `agents/`.
  const agentFiles: string[] = [];
  const agentDirs = manifest.agents === undefined ? [join(dir, "agents")] : [];
  for (const rel of listOf(manifest.agents)) {
    const path = inside(dir, rel, b);
    if (path && (await isFile(fs, path))) agentFiles.push(path);
    else if (path) agentDirs.push(path);
  }
  for (const d of agentDirs)
    for (const f of await children(fs, d, "file")) agentFiles.push(join(d, f));
  for (const path of agentFiles) {
    if (!path.endsWith(".md")) continue;
    const { data, body } = parseFrontMatterSafe(dec.decode(await bytesOf(fs, path)), path, b);
    if (!data) continue;
    const name = typeof data.name === "string" ? data.name : (path.split("/").pop() ?? "");
    const stem = name.replace(/\.md$/, "");
    if (!isItemName(stem)) {
      b.problem(`agent '${stem}' is not a valid name; skipped`);
      continue;
    }
    b.add(
      `${EXTENSION}/agents/${stem}.md`,
      enc.encode(formatFrontMatter({ name: stem, ...convertClaudeAgent(data, b.name) }, body)),
    );
  }
  // MCP servers: `.mcp.json`, merged with the manifest's (a path or the servers themselves).
  let servers: Record<string, unknown> = {};
  if (await isFile(fs, join(dir, ".mcp.json"))) {
    const mcp = await readJson(fs, join(dir, ".mcp.json"));
    servers = { ...((mcp.mcpServers ?? mcp) as Record<string, unknown>) };
  }
  if (typeof manifest.mcpServers === "string") {
    const path = inside(dir, manifest.mcpServers, b);
    if (path && (await isFile(fs, path))) {
      const mcp = await readJson(fs, path);
      servers = { ...servers, ...((mcp.mcpServers ?? mcp) as Record<string, unknown>) };
    }
  } else if (manifest.mcpServers && typeof manifest.mcpServers === "object")
    servers = { ...servers, ...(manifest.mcpServers as Record<string, unknown>) };
  if (Object.keys(servers).length)
    b.add("mcp.json", json({ $schema: MCP_SCHEMA, mcpServers: mcpOf(servers, b) }));
}

function parseFrontMatterSafe(text: string, path: string, b: Builder) {
  try {
    return parseFrontMatter(text);
  } catch (e) {
    b.problem(`${path.split("/").pop()}: ${(e as Error).message}; skipped`);
    return { data: undefined, body: "" };
  }
}

/**
 * Reads the plugin source in folder `dir` of `fs`, in whichever supported layout it has. A plugin
 * that can't be loaded is reported in `problems` and left out; smaller problems (an unknown
 * manifest field, a skill with a bad name) are reported and that part is skipped.
 */
export async function readPlugin(
  fs: FilesApi,
  dir: string,
): Promise<{ plugin?: Plugin; problems: string[] }> {
  const problems: string[] = [];
  const folder = dir.split("/").pop() || dir;
  try {
    const root = join(dir, "plugin.json");
    const claude = join(dir, ".claude-plugin/plugin.json");
    let layout: Plugin["layout"];
    let manifest: Record<string, unknown> = {};
    if (await isFile(fs, root)) {
      manifest = await readJson(fs, root);
      if (ACCEPTED_SCHEMAS.includes(String(manifest.$schema))) layout = "agent-plugins";
      else if (await isFile(fs, claude)) layout = "claude-code";
      else throw new Rejected(`plugin.json names an unsupported $schema '${manifest.$schema}'`);
    } else layout = "claude-code";
    if (layout === "claude-code") {
      if (await isFile(fs, claude)) manifest = await readJson(fs, claude);
      else {
        manifest = {};
        const parts = ["skills", "agents", ".mcp.json"];
        const found = await Promise.all(parts.map((p) => fs.exists(join(dir, p))));
        if (!found.some(Boolean)) throw new Rejected("is not a plugin in a supported layout");
      }
    }
    const name = manifest.name === undefined && layout === "claude-code" ? folder : manifest.name;
    if (typeof name !== "string" || !isPluginName(name))
      throw new Rejected(`'${String(name)}' is not a valid plugin name`);
    const b = new Builder(name, problems);
    if (layout === "agent-plugins") await readAgentPlugin(fs, dir, manifest, b);
    else await readClaudePlugin(fs, dir, manifest, b);
    return {
      plugin: { name, layout, files: b.files, hash: await hashFiles(b.files) },
      problems,
    };
  } catch (e) {
    if (!(e instanceof Rejected)) throw e;
    problems.push(`${folder}: ${e.message}; not loaded`);
    return { problems };
  }
}

/** Reads every plugin source in the folders of `dir` (sorted), the first of a name winning. */
export async function readPlugins(
  fs: FilesApi,
  dir = "/",
): Promise<{ plugins: Plugin[]; problems: string[] }> {
  const plugins: Plugin[] = [];
  const problems: string[] = [];
  for (const folder of await children(fs, dir, "directory")) {
    const read = await readPlugin(fs, join(dir, folder));
    problems.push(...read.problems);
    if (!read.plugin) continue;
    if (plugins.some((p) => p.name === read.plugin?.name))
      problems.push(`${folder}: a plugin named '${read.plugin.name}' is already loaded; skipped`);
    else plugins.push(read.plugin);
  }
  problems.sort();
  return { plugins, problems };
}

/** Writes a plugin into a catalog at `/<name>/`, replacing what was there. */
export async function writePlugin(catalog: FilesApi, plugin: Plugin): Promise<void> {
  await catalog.remove(`/${plugin.name}`);
  for (const [path, data] of plugin.files) await catalog.write(`/${plugin.name}/${path}`, [data]);
}

/** The loader: every plugin source in `dir` of `sources`, written into the catalog. */
export async function loadPlugins(
  sources: FilesApi,
  catalog: FilesApi,
  options: { dir?: string } = {},
): Promise<{ plugins: { name: string; hash: string }[]; problems: string[] }> {
  const { plugins, problems } = await readPlugins(sources, options.dir ?? "/");
  for (const plugin of plugins) await writePlugin(catalog, plugin);
  return { plugins: plugins.map((p) => ({ name: p.name, hash: p.hash })), problems };
}
