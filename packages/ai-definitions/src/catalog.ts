// Reading a catalog in the standard layout: its plugins, and the skills, agents and tools in them,
// each named `<plugin>/<name>`.
import { type FilesApi, tryReadText } from "@statewalker/webrun-files";
import { parse } from "yaml";
import { EXTENSION, isItemName, isPluginName } from "./loader.js";

/** An operationId (#82): `<plugin>__<operationId>` then fits a provider's 64 characters. */
export const OPERATION_ID = /^[a-z][a-z0-9_]{0,47}$/;

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
  /** `<plugin>/<operationId>`. */
  id: string;
  plugin: string;
  operationId: string;
  /** The operation, from the plugin's OpenAPI file. */
  operation: Record<string, unknown>;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * Every tool in the catalog: the operations of each plugin's `tools/openapi.json|yaml|yml`. (The
 * restricted profile, tools without an OpenAPI file and the build are later tickets: #129, #130.)
 */
export async function catalogTools(catalog: FilesApi): Promise<CatalogTool[]> {
  const out: CatalogTool[] = [];
  for (const plugin of await catalogPlugins(catalog)) {
    let doc: unknown;
    for (const ext of ["json", "yaml", "yml"]) {
      const text = await tryReadText(catalog, `/${plugin}/${EXTENSION}/tools/openapi.${ext}`);
      if (text === undefined) continue;
      try {
        doc = ext === "json" ? JSON.parse(text) : parse(text, { maxAliasCount: 0 });
      } catch {
        doc = undefined;
      }
      break;
    }
    const paths = (doc as { paths?: Record<string, Record<string, unknown>> } | undefined)?.paths;
    if (!paths || typeof paths !== "object") continue;
    const seen = new Set<string>();
    for (const item of Object.values(paths)) {
      if (!item || typeof item !== "object") continue;
      for (const method of METHODS) {
        const operation = item[method] as Record<string, unknown> | undefined;
        const id = operation?.operationId;
        if (!operation || typeof id !== "string" || !OPERATION_ID.test(id) || seen.has(id))
          continue;
        seen.add(id);
        out.push({ id: `${plugin}/${id}`, plugin, operationId: id, operation });
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
