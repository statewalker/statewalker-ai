// Harnesses (Harnesses §1 and §3, UHP 2026-10-19; decided in statewalker/statewalker-root#108):
// each agent the caller may start is a harness named `<project>/<plugin>/<agent>`. UHP's schema
// wants harness ids prefixed `chrn_`, so the id is that name behind the prefix, its slashes
// spelled `~` (project, plugin and agent names hold none); a task's `metadata.harness_id` takes
// the bare name too. The workspace is the token's.
import type { AgentView, ModelView, SessionApi } from "@statewalker/ai-sessions";
import { uhpError } from "./errors.js";

export const HARNESS_PREFIX = "chrn_";
/** A harness's `base`: opaque to clients, the same for every agent. */
export const HARNESS_BASE = "statewalker";

/** An agent, by its project and `<plugin>/<agent>`. */
export interface HarnessRef {
  project: string;
  agent: string;
}

/** A harness's name: `<project>/<plugin>/<agent>`. */
export const harnessName = (ref: HarnessRef) => `${ref.project}/${ref.agent}`;

/** A harness's id: its name, prefixed and with its slashes spelled `~`. */
export const harnessId = (ref: HarnessRef) =>
  `${HARNESS_PREFIX}${harnessName(ref).replaceAll("/", "~")}`;

/** The agent a harness id (or its bare name) names; undefined when it names none. */
export function parseHarness(id: string): HarnessRef | undefined {
  const name = id.startsWith(HARNESS_PREFIX)
    ? id.slice(HARNESS_PREFIX.length).replaceAll("~", "/")
    : id;
  const parts = name.split("/");
  if (parts.length !== 3 || parts.some((p) => !p)) return undefined;
  return { project: parts[0] as string, agent: `${parts[1]}/${parts[2]}` };
}

/** A harness as UHP shows it. */
export const harnessView = (agent: AgentView) => ({
  id: harnessId({ project: agent.project, agent: agent.id }),
  object: "harness",
  name: harnessName({ project: agent.project, agent: agent.id }),
  base: HARNESS_BASE,
  baseLabel: "StateWalker agent",
  ...(agent.description ? { description: agent.description } : {}),
  ...(agent.model ? { defaultModel: agent.model } : {}),
  project: agent.project,
  agent: agent.id,
});

/** The agents the caller may start, in one project or all of theirs. */
export async function listHarnesses(
  api: Pick<SessionApi, "listAgents">,
  project?: string,
): Promise<AgentView[]> {
  return (await api.listAgents(project ? { project } : {})).agents;
}

/** The agent a harness id names, if the caller may start it; `harness_not_found` otherwise. */
export async function findHarness(
  api: Pick<SessionApi, "listAgents">,
  id: string,
  param?: string,
): Promise<AgentView> {
  const ref = parseHarness(id);
  const refused = () =>
    uhpError(404, "harness_not_found", `no harness '${id}'`, param ? { param } : {});
  if (!ref) throw refused();
  let agents: AgentView[];
  try {
    agents = await listHarnesses(api, ref.project);
  } catch (e) {
    // Not a member, or no such project: outside the caller's scope.
    if (/^E(ACCES|NOENT|INVAL):/.test(String((e as Error)?.message))) throw refused();
    throw e;
  }
  const found = agents.find((a) => a.id === ref.agent);
  if (!found) throw refused();
  return found;
}

/** A model as UHP lists it: available when configured and the caller may use it. */
export const modelView = (m: ModelView, defaultModel?: string) => ({
  id: m.id,
  object: "model",
  backend: m.provider,
  available: m.enabled && m.allowed,
  ...(m.aliases.length ? { aliases: m.aliases } : {}),
  ...(defaultModel === m.id ? { default: true } : {}),
});

/** A harness's models (`GET /v1/harnesses/{id}/models`). */
export async function harnessModels(
  api: Pick<SessionApi, "listModels">,
  agent: AgentView,
): Promise<Record<string, unknown>> {
  const { models } = await api.listModels({ project: agent.project });
  const listed = models.filter((m) => m.enabled);
  const fallback = listed.find((m) => m.allowed)?.id;
  const def = agent.model ?? fallback;
  return {
    harness_id: harnessId({ project: agent.project, agent: agent.id }),
    ...(def ? { default: def, backend: listed.find((m) => m.id === def)?.provider } : {}),
    models: listed.map((m) => modelView(m, def)),
  };
}

/**
 * The model catalogue (`GET /v1/models`): the models of every project the caller's harnesses are
 * in, by provider (UHP's backend); a model is available where it is in any of them.
 */
export async function modelCatalog(
  api: Pick<SessionApi, "listModels" | "listAgents">,
): Promise<Record<string, unknown>> {
  const agents = await listHarnesses(api);
  const projects = [...new Set(agents.map((a) => a.project))];
  const byId = new Map<string, ModelView>();
  for (const project of projects)
    for (const m of (await api.listModels({ project })).models) {
      if (!m.enabled) continue;
      const known = byId.get(m.id);
      if (!known || (!known.allowed && m.allowed)) byId.set(m.id, m);
    }
  const defaults = new Set(agents.map((a) => a.model).filter(Boolean));
  const backends: Record<string, { default: string; models: Record<string, unknown>[] }> = {};
  for (const m of [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    let backend = backends[m.provider];
    if (!backend) {
      backend = { default: "", models: [] };
      backends[m.provider] = backend;
    }
    backend.models.push(modelView(m));
    if (!backend.default || (defaults.has(m.id) && !defaults.has(backend.default)))
      backend.default = m.id;
  }
  return { object: "list", backends };
}
