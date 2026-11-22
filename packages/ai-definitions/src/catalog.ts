// Reading a catalog in the standard layout: its plugins, and the skills, agents and tools in them,
// each named `<plugin>/<name>`.
import type { FilesApi } from "@statewalker/webrun-files";
import { EXTENSION, isItemName, isPluginName } from "./loader.js";
import { catalogToolDefinitions, TOOL_EXTENSION, type ToolDefinition } from "./tools.js";

async function dirs(fs: FilesApi, dir: string): Promise<string[]> {
  const out: string[] = [];
  if ((await fs.stats(dir))?.kind !== "directory") return out;
  for await (const e of fs.list(dir)) if (e.kind === "directory") out.push(e.name);
  return out.sort();
}

async function files(fs: FilesApi, dir: string): Promise<string[]> {
  const out: string[] = [];
  if ((await fs.stats(dir))?.kind !== "directory") return out;
  for await (const e of fs.list(dir)) if (e.kind === "file") out.push(e.name);
  return out.sort();
}

/** The plugins of a catalog: its folders holding a `plugin.json`. */
export async function catalogPlugins(catalog: FilesApi): Promise<string[]> {
  const out: string[] = [];
  for (const name of await dirs(catalog, "/"))
    if (isPluginName(name) && (await catalog.exists(`/${name}/plugin.json`))) out.push(name);
  return out;
}

/** Every skill in the catalog, as `<plugin>/<skill>`. */
export async function catalogSkills(catalog: FilesApi): Promise<string[]> {
  const out: string[] = [];
  for (const plugin of await catalogPlugins(catalog))
    for (const skill of await dirs(catalog, `/${plugin}/skills`))
      if (isItemName(skill) && (await catalog.exists(`/${plugin}/skills/${skill}/SKILL.md`)))
        out.push(`${plugin}/${skill}`);
  return out;
}

/** Every agent in the catalog, as `<plugin>/<agent>`. */
export async function catalogAgents(catalog: FilesApi): Promise<string[]> {
  const out: string[] = [];
  for (const plugin of await catalogPlugins(catalog))
    for (const file of await files(catalog, `/${plugin}/${EXTENSION}/agents`)) {
      const name = file.replace(/\.md$/, "");
      if (file.endsWith(".md") && isItemName(name)) out.push(`${plugin}/${name}`);
    }
  return out;
}

export interface CatalogTool {
  /** `<plugin>/<tool>`. */
  id: string;
  plugin: string;
  /** The tool's operationId. */
  operationId: string;
  /** Its document in the restricted profile. */
  definition: ToolDefinition;
}

/**
 * Every tool in the catalog: the operations of each plugin's `tools/openapi.json|yaml|yml` and of
 * its imported REST specs (`tools/rest/`), each as its restricted-profile document (#129).
 */
export async function catalogTools(catalog: FilesApi): Promise<CatalogTool[]> {
  return (await catalogToolDefinitions(catalog)).map((definition) => {
    const x = definition[TOOL_EXTENSION];
    return { id: x.id, plugin: x.plugin, operationId: x.tool, definition };
  });
}
