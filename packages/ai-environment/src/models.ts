// Providers, models and aliases (statewalker/statewalker-root#105, #134). Each of four levels
// (deployment, workspace, project, user) holds the same configuration: providers and models it
// adds, an `allow` list narrowing the models broader levels configured, aliases, and a default.
// The levels are folded broadest first into one catalog; a session's model is picked from it within
// the user's model rights (`models.use:<provider>/<model>` or `models.use:<alias>`).
import { codedError } from "@statewalker/ai-access";

export type ModelLevel = "deployment" | "workspace" | "project" | "user";

/** Broadest first: the order levels are folded in. */
export const MODEL_LEVELS: readonly ModelLevel[] = ["deployment", "workspace", "project", "user"];

/** The model APIs the gateway speaks (pi-ai's), and `local` (the browser's own engines). */
export const MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "local",
] as const;
export type ModelApi = (typeof MODEL_APIS)[number];

/** A connection to a model service; its key is a secret bound to the gateway and its host. */
export interface Provider {
  id: string;
  api: ModelApi;
  baseUrl: string;
  /** Sent with every request; values may name secrets (`{{secret:NAME}}`). */
  headers?: Record<string, string>;
  /** The secret holding the provider's key. */
  secret?: string;
}

/** Prices per million tokens, in the deployment's price unit. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelDefinition {
  /** `<provider>/<model>`. */
  id: string;
  /** Role names (`fast`, `smart`, `vision`, …) agents may ask for instead of the id. */
  alias?: string | string[];
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  cost?: ModelCost;
}

/** One level's model configuration. */
export interface ModelsConfig {
  providers?: Provider[];
  models?: ModelDefinition[];
  /**
   * Narrows: the models broader levels configured stay only if one of these names them (an id or
   * an alias, `*` matching any characters). The level's own models always stay.
   */
  allow?: string[];
  /** The level's default model (an id or an alias); read at project, workspace and deployment. */
  default?: string;
}

export interface CatalogProvider extends Provider {
  level: ModelLevel;
}

export interface CatalogModel {
  id: string;
  provider: string;
  /** The model's name at its provider: the id without `<provider>/`. */
  name: string;
  /** The aliases that pick it (each alias picks one model: the most specific level's). */
  aliases: string[];
  level: ModelLevel;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  cost?: ModelCost;
}

/** The levels folded into one: what a session in one project, for one user, may be served. */
export interface ModelCatalog {
  providers: Record<string, CatalogProvider>;
  models: Record<string, CatalogModel>;
  /** alias → model id. */
  aliases: Record<string, string>;
  defaults: Partial<Record<ModelLevel, string>>;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/;
const ALIAS = /^[a-z][a-z0-9_-]{0,63}$/;
const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ENTRIES = 256;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Splits `<provider>/<model>`; undefined when it is not one. */
export function splitModelId(id: string): { provider: string; name: string } | undefined {
  const slash = id.indexOf("/");
  if (slash < 1) return undefined;
  const provider = id.slice(0, slash);
  const name = id.slice(slash + 1);
  return ID.test(provider) && MODEL_NAME.test(name) ? { provider, name } : undefined;
}

function providerOf(v: unknown): Provider | string {
  if (!isRecord(v)) return "a provider is an object";
  const { id, api, baseUrl, headers, secret } = v;
  if (typeof id !== "string" || !ID.test(id)) return `provider id '${String(id)}' is malformed`;
  if (typeof api !== "string" || !(MODEL_APIS as readonly string[]).includes(api))
    return `provider ${id}: api is one of ${MODEL_APIS.join(", ")}`;
  let url: URL | undefined;
  try {
    url = typeof baseUrl === "string" ? new URL(baseUrl) : undefined;
  } catch {
    url = undefined;
  }
  if (api !== "local" && (!url || (url.protocol !== "https:" && url.protocol !== "http:")))
    return `provider ${id}: baseUrl is an http(s) URL`;
  if (
    headers !== undefined &&
    (!isRecord(headers) || Object.values(headers).some((h) => typeof h !== "string"))
  )
    return `provider ${id}: headers are strings`;
  if (secret !== undefined && (typeof secret !== "string" || !SECRET.test(secret)))
    return `provider ${id}: secret names a secret`;
  return {
    id,
    api: api as ModelApi,
    baseUrl: String(baseUrl ?? ""),
    ...(headers ? { headers: headers as Record<string, string> } : {}),
    ...(secret ? { secret: secret as string } : {}),
  };
}

const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const price = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;

function modelOf(v: unknown): ModelDefinition | string {
  if (!isRecord(v)) return "a model is an object";
  const { id, alias, contextWindow, maxTokens, input, cost } = v;
  if (typeof id !== "string" || !splitModelId(id))
    return `model id '${String(id)}' is not '<provider>/<model>'`;
  const aliases = alias === undefined ? [] : Array.isArray(alias) ? alias : [alias];
  if (!aliases.every((a) => typeof a === "string" && ALIAS.test(a)))
    return `model ${id}: an alias is a lowercase name`;
  if (contextWindow !== undefined && !positive(contextWindow))
    return `model ${id}: contextWindow is a positive number`;
  if (maxTokens !== undefined && !positive(maxTokens))
    return `model ${id}: maxTokens is a positive number`;
  if (
    input !== undefined &&
    (!Array.isArray(input) || !input.every((i) => i === "text" || i === "image"))
  )
    return `model ${id}: input is a list of text and image`;
  if (
    cost !== undefined &&
    (!isRecord(cost) ||
      !price(cost.input) ||
      !price(cost.output) ||
      (cost.cacheRead !== undefined && !price(cost.cacheRead)) ||
      (cost.cacheWrite !== undefined && !price(cost.cacheWrite)))
  )
    return `model ${id}: cost is {input, output, cacheRead?, cacheWrite?} per million tokens`;
  return {
    id,
    ...(alias !== undefined ? { alias: alias as string | string[] } : {}),
    ...(contextWindow !== undefined ? { contextWindow: contextWindow as number } : {}),
    ...(maxTokens !== undefined ? { maxTokens: maxTokens as number } : {}),
    ...(input !== undefined ? { input: input as ("text" | "image")[] } : {}),
    ...(cost !== undefined ? { cost: cost as unknown as ModelCost } : {}),
  };
}

/**
 * One level's configuration, read leniently: each malformed entry is reported and left out, so a
 * typo in one model never takes a level's other models away. Unreadable text is an empty level.
 */
export function parseModelsConfig(value: unknown): { config: ModelsConfig; problems: string[] } {
  const problems: string[] = [];
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { config: {}, problems: ["the model configuration is not JSON"] };
    }
  }
  if (value === undefined || value === null) return { config: {}, problems };
  if (!isRecord(value)) return { config: {}, problems: ["the model configuration is an object"] };
  const config: ModelsConfig = {};
  const providers: Provider[] = [];
  const models: ModelDefinition[] = [];
  const list = (key: string) => {
    const v = value[key as keyof typeof value];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MAX_ENTRIES) {
      problems.push(`${key} is a list of at most ${MAX_ENTRIES}`);
      return [];
    }
    return v;
  };
  for (const p of list("providers")) {
    const found = providerOf(p);
    if (typeof found === "string") problems.push(found);
    else providers.push(found);
  }
  for (const m of list("models")) {
    const found = modelOf(m);
    if (typeof found === "string") problems.push(found);
    else models.push(found);
  }
  if (providers.length) config.providers = providers;
  if (models.length) config.models = models;
  const allow = list("allow");
  if (value.allow !== undefined) {
    if (allow.every((a) => typeof a === "string" && a.length > 0 && a.length <= 256))
      config.allow = allow as string[];
    else problems.push("allow is a list of model ids and aliases");
  }
  if (value.default !== undefined) {
    if (typeof value.default === "string" && value.default) config.default = value.default;
    else problems.push("default names a model");
  }
  return { config, problems };
}

/** One level's configuration, read strictly (what a user sets): EINVAL on any problem. */
export function checkModelsConfig(value: unknown): ModelsConfig {
  if (!isRecord(value)) throw codedError("EINVAL", "the model configuration is an object");
  const unknown = Object.keys(value).filter(
    (k) => !["providers", "models", "allow", "default"].includes(k),
  );
  if (unknown.length) throw codedError("EINVAL", `unknown fields: ${unknown.join(", ")}`);
  const { config, problems } = parseModelsConfig(value);
  if (problems.length) throw codedError("EINVAL", problems.join("; "));
  return config;
}

const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/**
 * Folds the levels, broadest first, into one catalog:
 * - providers and models are added; an id a broader level already holds stays the broader level's
 *   (a narrower level can only give a broader model more aliases);
 * - `allow` keeps only the broader models it names (by id or alias);
 * - an alias picks the most specific level's model;
 * - each level's default is kept for the session's pick.
 */
export function resolveModels(levels: readonly { level: ModelLevel; config: ModelsConfig }[]): {
  catalog: ModelCatalog;
  problems: string[];
} {
  const problems: string[] = [];
  const catalog: ModelCatalog = { providers: {}, models: {}, aliases: {}, defaults: {} };
  for (const { level, config } of levels) {
    for (const p of config.providers ?? []) {
      if (catalog.providers[p.id]) {
        problems.push(`${level}: provider ${p.id} is already configured at a broader level`);
        continue;
      }
      catalog.providers[p.id] = { ...p, level };
    }
    const own = new Set<string>();
    for (const m of config.models ?? []) {
      const aliases = m.alias === undefined ? [] : Array.isArray(m.alias) ? m.alias : [m.alias];
      const known = catalog.models[m.id];
      if (!known) {
        const split = splitModelId(m.id);
        if (!split || !catalog.providers[split.provider]) {
          problems.push(`${level}: model ${m.id} names no configured provider`);
          continue;
        }
        catalog.models[m.id] = {
          id: m.id,
          provider: split.provider,
          name: split.name,
          aliases: [],
          level,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
          ...(m.input ? { input: m.input } : {}),
          ...(m.cost ? { cost: m.cost } : {}),
        };
        own.add(m.id);
      }
      for (const a of aliases) catalog.aliases[a] = m.id;
    }
    if (config.allow) {
      const patterns = config.allow.map(glob);
      const named = (id: string) =>
        patterns.some(
          (p) =>
            p.test(id) ||
            Object.entries(catalog.aliases).some(([a, target]) => target === id && p.test(a)),
        );
      for (const id of Object.keys(catalog.models))
        if (!own.has(id) && !named(id)) delete catalog.models[id];
    }
    if (config.default) catalog.defaults[level] = config.default;
  }
  for (const [alias, id] of Object.entries(catalog.aliases)) {
    const model = catalog.models[id];
    if (model) model.aliases.push(alias);
    else delete catalog.aliases[alias];
  }
  return { catalog, problems };
}

/** The model a name (an id or an alias) picks in the catalog. */
export function lookupModel(catalog: ModelCatalog, name: string): CatalogModel | undefined {
  const byAlias = Object.hasOwn(catalog.aliases, name) ? catalog.aliases[name] : undefined;
  const id = byAlias ?? name;
  return Object.hasOwn(catalog.models, id) ? catalog.models[id] : undefined;
}

/** Whether the user holds `models.use` for a target (an id or an alias). */
export type ModelRight = (target: string) => boolean | Promise<boolean>;

/** A model is the user's when they hold its right by id or by any alias that picks it. */
export async function mayUse(model: CatalogModel, right: ModelRight): Promise<boolean> {
  if (await right(model.id)) return true;
  for (const alias of model.aliases) if (await right(alias)) return true;
  return false;
}

/** Why a name gives no model: configured nowhere, or not the user's. */
export type Unusable = "unconfigured" | "forbidden";

/** The model a name picks, if configured and the user's; otherwise why not. */
export async function usableModel(
  catalog: ModelCatalog,
  name: string,
  right: ModelRight,
): Promise<{ model: CatalogModel } | { why: Unusable }> {
  const model = lookupModel(catalog, name);
  if (!model) return { why: "unconfigured" };
  return (await mayUse(model, right)) ? { model } : { why: "forbidden" };
}

/** A session's models, pinned at its start: the catalog, its model, and what it falls back to. */
export interface PinnedModels {
  catalog: ModelCatalog;
  /** The session's model (an id). */
  model: string;
  /** The agent's other models, in its order (ids): tried for one request when the model fails. */
  fallbacks: string[];
}

/**
 * Picks a session's model: the user's override (which must be configured and theirs), else the
 * first configured model in the agent's list the user may use, else the project's, workspace's and
 * deployment's default. Nothing fits: ENOENT naming everything asked for (EACCES for an override
 * the user holds no right to).
 */
export async function pickSessionModel(
  catalog: ModelCatalog,
  options: { override?: string; agentModels: readonly string[]; right: ModelRight },
): Promise<PinnedModels> {
  const { override, agentModels, right } = options;
  const fallbacksAfter = async (chosen: string) => {
    const out: string[] = [];
    for (const name of agentModels) {
      const found = await usableModel(catalog, name, right);
      if ("model" in found && found.model.id !== chosen && !out.includes(found.model.id))
        out.push(found.model.id);
    }
    return out;
  };
  if (override !== undefined) {
    const found = await usableModel(catalog, override, right);
    if ("why" in found)
      throw found.why === "unconfigured"
        ? codedError("ENOENT", `no model '${override}' is configured here`)
        : codedError("EACCES", `you hold no right to the model '${override}'`);
    return { catalog, model: found.model.id, fallbacks: await fallbacksAfter(found.model.id) };
  }
  const asked: string[] = [];
  for (const [i, name] of agentModels.entries()) {
    asked.push(name);
    const found = await usableModel(catalog, name, right);
    if ("model" in found) {
      const rest: string[] = [];
      for (const later of agentModels.slice(i + 1)) {
        const next = await usableModel(catalog, later, right);
        if ("model" in next && next.model.id !== found.model.id && !rest.includes(next.model.id))
          rest.push(next.model.id);
      }
      return { catalog, model: found.model.id, fallbacks: rest };
    }
  }
  for (const level of ["project", "workspace", "deployment"] as const) {
    const name = catalog.defaults[level];
    if (!name) continue;
    asked.push(`${name} (the ${level}'s default)`);
    const found = await usableModel(catalog, name, right);
    if ("model" in found)
      return { catalog, model: found.model.id, fallbacks: await fallbacksAfter(found.model.id) };
  }
  throw codedError(
    "ENOENT",
    asked.length
      ? `no configured model you may use: asked for ${asked.join(", ")}`
      : "no model is configured here",
  );
}

/** IPv4 and IPv6 literals of loopback, private, link-local and unspecified addresses. */
function privateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "metadata.google.internal")
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":"))
    return (
      h === "::" ||
      h === "::1" ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("fe80") ||
      h.startsWith("::ffff:")
    );
  return false;
}

/**
 * A user-level provider's address (a user's own connection): HTTPS, and not a loopback, private or
 * link-local address literal, unless the deployment lists its host (a test deployment's local
 * model). Until the egress gateway resolves names itself (statewalker/statewalker-root#208), a
 * name that resolves to a private address is not caught here.
 */
export function checkUserProvider(provider: Provider, allowedHosts: readonly string[]): void {
  if (provider.api === "local") return;
  const url = new URL(provider.baseUrl);
  if (allowedHosts.includes(url.hostname.toLowerCase())) return;
  if (url.protocol !== "https:")
    throw codedError("EINVAL", `provider ${provider.id}: a user's provider is reached over https`);
  if (privateAddress(url.hostname))
    throw codedError(
      "EINVAL",
      `provider ${provider.id}: a user's provider is not at a private or loopback address`,
    );
}
