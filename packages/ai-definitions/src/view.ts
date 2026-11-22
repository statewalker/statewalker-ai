// The definitions mount (statewalker/statewalker-root#80, #82): the catalog as one user may use it
// in one project, a read-only tree mounted at `<project>/.agents/`:
//
//   skills/<plugin>/<skill>/SKILL.md             registered with Flue by the harness, by name
//   agents/<plugin>__<agent>.md
//   tools/<plugin>__<operationId>.openapi.json   one document per tool, in the restricted profile
//
// Each entry shows only while the user's `skills.use` / `agents.use` / `tools.use` permission for
// it holds (for a read tool, `tools.read` too), decided at every call, so a demotion reaches an
// open view. An agent session's view shows only the skills its agent asks for.
import { codedError } from "@statewalker/ai-access";
import { type FilesApi, readFile } from "@statewalker/webrun-files";
import { FilteredFilesApi } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { Allow, NarrowedAgent } from "./agents.js";
import { catalogAgents, catalogSkills, catalogTools } from "./catalog.js";
import { EXTENSION } from "./loader.js";
import { TOOL_EXTENSION, type ToolAction, type ToolDefinition } from "./tools.js";

const enc = new TextEncoder();

/**
 * What a path of the view shows: the item it belongs to, a plugin's skills folder (`plugin`), or
 * nothing (a folder of the layout).
 */
function itemOf(
  path: string,
  tools: ReadonlyMap<string, ToolDefinition>,
):
  | { area: "skills" | "agents"; id: string }
  | { area: "tools"; id: string; action: ToolAction }
  | { plugin: string }
  | undefined {
  const [, top, entry, rest] = path.split("/");
  if (!entry) return undefined;
  if (top === "skills")
    return rest ? { area: "skills", id: `${entry}/${rest}` } : { plugin: entry };
  if (top === "tools") {
    // Tool files are named by the projected name, which may be cut and hashed: looked up.
    const x = tools.get(entry)?.[TOOL_EXTENSION];
    return x ? { area: "tools", id: x.id, action: x.action } : { area: "skills", id: "" };
  }
  const qualified = top === "agents" ? entry.replace(/\.md$/, "") : undefined;
  const at = qualified?.indexOf("__") ?? -1;
  if (!qualified || at < 1) return { area: "skills", id: "" };
  const id = `${qualified.slice(0, at)}/${qualified.slice(at + 2)}`;
  return { area: "agents", id };
}

/** Every mutating call refused: the definitions are the catalog's, never a session's. */
function readOnly(fs: FilesApi): FilesApi {
  const refuse = async (path: string) => {
    throw codedError("EACCES", `the definitions mount is read-only: '${path}'`);
  };
  return {
    read: (p, o) => fs.read(p, o),
    list: (p, o) => fs.list(p, o),
    stats: (p) => fs.stats(p),
    exists: (p) => fs.exists(p),
    write: (p) => refuse(p),
    mkdir: (p) => refuse(p),
    remove: (p) => refuse(p),
    move: (s) => refuse(s),
    copy: (_s, t) => refuse(t),
  };
}

/** The whole tree of a catalog, under qualified names, before any permission. */
async function treeOf(
  catalog: FilesApi,
): Promise<{ tree: MemFilesApi; tools: Map<string, ToolDefinition> }> {
  const tree = new MemFilesApi();
  for (const dir of ["skills", "agents", "tools"]) await tree.mkdir(`/${dir}`);
  for (const id of await catalogSkills(catalog)) {
    const [plugin, skill] = id.split("/") as [string, string];
    const root = `/${plugin}/skills/${skill}`;
    for await (const e of catalog.list(root, { recursive: true }))
      if (e.kind === "file")
        await tree.write(`/skills/${plugin}/${skill}${e.path.slice(root.length)}`, [
          await readFile(catalog, e.path),
        ]);
  }
  for (const id of await catalogAgents(catalog)) {
    const [plugin, agent] = id.split("/") as [string, string];
    await tree.write(`/agents/${plugin}__${agent}.md`, [
      await readFile(catalog, `/${plugin}/${EXTENSION}/agents/${agent}.md`),
    ]);
  }
  const tools = new Map<string, ToolDefinition>();
  for (const { definition } of await catalogTools(catalog)) {
    const file = `${definition[TOOL_EXTENSION].name}.openapi.json`;
    tools.set(file, definition);
    await tree.write(`/tools/${file}`, [enc.encode(`${JSON.stringify(definition, null, 2)}\n`)]);
  }
  return { tree, tools };
}

export interface DefinitionsViewOptions {
  /** Whether the user may use an item now (their `<area>.use` permissions in the project). */
  allow: Allow;
  /** The session's agent, narrowed: only its skills show. */
  agent?: NarrowedAgent;
}

/** The read-only definitions view of a catalog for one user in one project (and one agent). */
export async function definitionsView(
  catalog: FilesApi,
  options: DefinitionsViewOptions,
): Promise<FilesApi> {
  const { tree, tools } = await treeOf(catalog);
  const skills = options.agent ? new Set(options.agent.skills) : undefined;
  const all = await catalogSkills(catalog);
  const shows = async (area: "skills" | "agents" | "tools", id: string, action?: ToolAction) => {
    if (!id) return false;
    if (area === "skills" && skills && !skills.has(id)) return false;
    return options.allow(area, id, action);
  };
  return readOnly(
    new FilteredFilesApi(tree, async (path) => {
      const item = itemOf(path, tools);
      if (!item) return true;
      // A plugin's skills folder shows while one of its skills does.
      if ("plugin" in item) {
        for (const id of all)
          if (id.startsWith(`${item.plugin}/`) && (await shows("skills", id))) return true;
        return false;
      }
      return shows(item.area, item.id, "action" in item ? item.action : undefined);
    }),
  );
}
