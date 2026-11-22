// Agent definitions (statewalker/statewalker-root#82): `agents/<name>.md` files whose front matter
// names the models, skills, tools and sub-agents the agent asks for, and whose body holds its
// always-on instructions. Every list is a request, narrowed by the user's permissions; a missing
// list means none, except `skills`, where it means every visible skill.
import { type FilesApi, tryReadText } from "@statewalker/webrun-files";
import { catalogAgents, catalogSkills, catalogTools } from "./catalog.js";
import { parseFrontMatter } from "./front-matter.js";
import { EXTENSION, isItemName, isPluginName } from "./loader.js";
import type { ToolAction } from "./tools.js";

/**
 * Whether the user may use a skill, tool, agent or model (`<area>.use:<target>`) now; for a tool,
 * its action is given, since a read tool may also be used with `tools.read` (readers).
 */
export type Allow = (
  area: "skills" | "tools" | "agents" | "models",
  target: string,
  action?: ToolAction,
) => boolean | Promise<boolean>;

export interface AgentDefinition {
  /** `<plugin>/<name>`. */
  id: string;
  plugin: string;
  name: string;
  description?: string;
  /** Models in order of preference. */
  models: string[];
  /** Skill patterns (`<plugin>/<skill>`, `*` for any characters); missing: every visible skill. */
  skills?: string[];
  /** Tool patterns (`<plugin>/<operationId>`). */
  tools: string[];
  /** Sub-agent patterns (`<plugin>/<agent>`). */
  agents: string[];
  /** A mode, which may only be stricter than the session's. */
  mode?: string;
  /** What the agent needs of the environment (statewalker/statewalker-root#94). */
  requires?: unknown;
  /** The body: always-on instructions. */
  instructions: string;
}

/** An agent's lists after narrowing: the ids the user may use, never patterns. */
export interface NarrowedAgent extends AgentDefinition {
  skills: string[];
}

const strings = (v: unknown): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  const list = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : [];
  return list.map((s) => String(s).trim()).filter(Boolean);
};

/** Parses an agent file of plugin `plugin`, named `name` (its file name). */
export function parseAgent(plugin: string, name: string, text: string): AgentDefinition {
  const { data, body } = parseFrontMatter(text);
  const def: AgentDefinition = {
    id: `${plugin}/${name}`,
    plugin,
    name,
    models: strings(data.models ?? data.model) ?? [],
    tools: strings(data.tools) ?? [],
    agents: strings(data.agents) ?? [],
    instructions: body.replace(/^\r?\n/, ""),
  };
  if (typeof data.description === "string") def.description = data.description;
  const skills = strings(data.skills);
  if (skills) def.skills = skills;
  if (typeof data.mode === "string") def.mode = data.mode;
  if (data.requires !== undefined) def.requires = data.requires;
  return def;
}

/** The agent `<plugin>/<name>` of the catalog, or undefined. */
export async function findAgent(
  catalog: FilesApi,
  id: string,
): Promise<AgentDefinition | undefined> {
  const [plugin, name, ...rest] = id.split("/");
  if (rest.length || !plugin || !name || !isPluginName(plugin) || !isItemName(name))
    return undefined;
  const text = await tryReadText(catalog, `/${plugin}/${EXTENSION}/agents/${name}.md`);
  if (text === undefined) return undefined;
  try {
    return parseAgent(plugin, name, text);
  } catch {
    return undefined;
  }
}

/** A request pattern: `<plugin>/<name>` (or `<plugin>__<name>`), `*` for any characters. */
export function matches(pattern: string, id: string): boolean {
  const p = pattern.replace("__", "/");
  const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return re.test(id);
}

async function allowed(
  ids: readonly string[],
  area: Parameters<Allow>[0],
  allow: Allow,
  patterns?: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids)
    if ((!patterns || patterns.some((p) => matches(p, id))) && (await allow(area, id)))
      out.push(id);
  return out;
}

/**
 * Narrows an agent's requests by the permissions: the skills, tools and sub-agents it asks for that
 * the catalog has and the user may use, and the models the user may use, in its order.
 */
export async function narrowAgent(
  catalog: FilesApi,
  agent: AgentDefinition,
  allow: Allow,
): Promise<NarrowedAgent> {
  const tools: string[] = [];
  for (const t of await catalogTools(catalog))
    if (
      (!agent.tools || agent.tools.some((p) => matches(p, t.id))) &&
      (await allow("tools", t.id, t.definition["x-dev.cellb.harness"].action))
    )
      tools.push(t.id);
  const models: string[] = [];
  for (const m of agent.models) if (await allow("models", m)) models.push(m);
  return {
    ...agent,
    models,
    skills: await allowed(await catalogSkills(catalog), "skills", allow, agent.skills),
    tools,
    agents: await allowed(await catalogAgents(catalog), "agents", allow, agent.agents),
  };
}
