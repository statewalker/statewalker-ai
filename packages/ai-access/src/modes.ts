// Modes and permission rules (statewalker/statewalker-root#79, built by #124). A mode is a named
// bundle of allow/ask/deny rules, matched by permission and target or by tool name, with a verdict
// for actions no rule matches. Modes are definitions, not code: the built-in ones are written the
// same way a deployment writes its own. Rules come from the deployment, the project, the user, the
// agent session and the active mode; deny beats ask, and ask beats allow. A mode only narrows what
// the capability and the member's roles allow: the gate checks those first.
import { codedError } from "./errors.js";
import { type AccessRequest, type Permission, parsePermissions, permits } from "./permissions.js";

export type Verdict = "allow" | "ask" | "deny";

/** Rule entries are permissions (`files.write:/src/**`) or tool names (`tool:bash`). */
export interface PermissionRules {
  allow?: readonly string[];
  ask?: readonly string[];
  deny?: readonly string[];
}

/** Rules from one source: the deployment, the project, the user or the agent session. */
export interface RuleLayer {
  source: string;
  rules: PermissionRules;
  /**
   * Whether the layer's targets match only themselves, never as patterns: "approve for this
   * session" covers the same permission on the same target, not a folder's subtree or what a file
   * name holding `*` would spell.
   */
  exact?: boolean;
}

export interface ModeDefinition {
  /** A mode this one starts from: its rules and settings, overridden by this one's. */
  extends?: string;
  /** `{folders}` in a rule's target stands for each of the mode's folders (relative to the project). */
  rules?: PermissionRules;
  folders?: readonly string[];
  /** The verdict of an action no rule matches (default "ask"). */
  otherwise?: Verdict;
  /** What "ask" becomes in this mode: `bypassPermissions` allows it, `dontAsk` denies it. */
  asks?: "allow" | "deny";
  /** Why this mode asks about an action no rule matches, shown with the approval. */
  askReason?: string;
  /**
   * Whether the risk classifier decides what no rule and no safe class settles (`auto`,
   * statewalker/statewalker-root#96); without it, such actions get `otherwise`.
   */
  classifier?: boolean;
}

/** The mode a new user session starts in. */
export const DEFAULT_MODE = "default";

/** The name of a project's rules file in its system folder, and of a user's in their profile. */
export const PERMISSION_RULES_FILE = "permission-rules";

/** Rules that ask about everything: what unreadable rules count as, so they never widen. */
const ASK_ALL: PermissionRules = { ask: ["*.*"] };

/**
 * Rules from JSON text or a value: `{allow?, ask?, deny?}`, each a list of rule entries. Missing
 * rules (undefined, null, "") are none; unreadable ones ask about everything. Entries naming no
 * known permission are ignored when deciding, as in roles.
 */
export function parseRules(value: unknown): PermissionRules {
  if (value === undefined || value === null || value === "") return {};
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return ASK_ALL;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return ASK_ALL;
  const out: { -readonly [K in keyof PermissionRules]: string[] } = {};
  for (const key of ["allow", "ask", "deny"] as const) {
    const list = (v as Record<string, unknown>)[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((e) => typeof e !== "string")) return ASK_ALL;
    out[key] = list as string[];
  }
  return out;
}

// `tools.read`: a tool whose action is read (statewalker/statewalker-root#129).
const READS = ["files.read", "files.list", "comments.read", "db.read", "tools.read"];

// Memory is written in every mode but `plan` (statewalker/statewalker-root#157): what an agent
// may write is decided by the roles (`memory.write:project|agent`) and, for preferences, by the
// user's approval in every mode; `plan` denies every memory write.
const MEMORY = ["memory.write"];

/** The built-in modes, with Claude Code's identifiers (#79). */
export const BUILT_IN_MODES: Readonly<Record<string, ModeDefinition>> = {
  default: {
    rules: { allow: [...READS, ...MEMORY] },
    otherwise: "ask",
    askReason: "default mode asks before changing anything",
  },
  acceptEdits: {
    // Database writes are edits too (statewalker/statewalker-root#81).
    rules: { allow: [...READS, ...MEMORY, "files.write", "comments.write", "db.write"] },
    otherwise: "ask",
    askReason: "acceptEdits mode allows file and database edits; deletes and other actions ask",
  },
  plan: {
    rules: {
      allow: [...READS, "files.write:{folders}", "files.delete:{folders}"],
      deny: MEMORY,
    },
    folders: ["/plans"],
    otherwise: "ask",
    askReason:
      "plan mode writes only in {folders}: allow to widen access, or switch to a writing mode",
  },
  // The risk classifier decides in `auto` what no rule and no safe class settles (#96, #137); where
  // no classifier runs (a sub-agent's own modes), `auto` asks as `default` does.
  // Not `default`'s rules: memory writes, which `default` allows, go to the classifier here (#157).
  auto: {
    rules: { allow: READS },
    otherwise: "ask",
    classifier: true,
    askReason: "auto mode's risk classifier asks before this action",
  },
  bypassPermissions: { otherwise: "allow", asks: "allow" },
  dontAsk: {
    rules: { allow: [...READS, ...MEMORY] },
    otherwise: "deny",
    asks: "deny",
    askReason: "dontAsk mode denies what no allow rule allows",
  },
};

/** A mode with its `extends` chain and settings applied. */
export interface ResolvedMode {
  name: string;
  allow: CompiledRule[];
  ask: CompiledRule[];
  deny: CompiledRule[];
  otherwise: Verdict;
  asks?: "allow" | "deny";
  askReason?: string;
  classifier?: boolean;
}

type CompiledRule = { permission: Permission } | { tool: string };

const VERDICTS: readonly Verdict[] = ["deny", "ask", "allow"];
const MODE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * A rule layer's entries, compiled once per list (statewalker-ai#49: a folder's removal decides
 * every entry inside it against the same layers). Lists are keyed by identity: a layer read again
 * is a new list, compiled again.
 */
const COMPILED = new WeakMap<readonly string[], CompiledRule[]>();
function compiledLayer(entries: readonly string[] | undefined): CompiledRule[] {
  if (!Array.isArray(entries)) return compile(entries, [], []);
  let out = COMPILED.get(entries);
  if (!out) {
    out = compile(entries, [], []);
    COMPILED.set(entries, out);
  }
  return out;
}

function compile(
  entries: readonly string[] | undefined,
  folders: readonly string[],
  problems: string[],
) {
  const out: CompiledRule[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry !== "string") {
      problems.push(`'${String(entry)}': a rule is a string`);
      continue;
    }
    if (entry.startsWith("tool:")) {
      const tool = entry.slice(5);
      if (tool) out.push({ tool });
      else problems.push(`'${entry}': no tool name`);
      continue;
    }
    const texts = entry.includes("{folders}")
      ? folders.map((f) => entry.replace("{folders}", f))
      : [entry];
    const parsed = parsePermissions(texts);
    problems.push(...parsed.problems);
    for (const permission of parsed.permissions) out.push({ permission });
  }
  return out;
}

/** Definitions by name (a deployment's), each checked; problems are reported and grant nothing. */
export function parseModes(value: unknown): {
  modes: Record<string, ModeDefinition>;
  problems: string[];
} {
  const modes: Record<string, ModeDefinition> = {};
  const problems: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { modes, problems: value === undefined ? [] : ["modes are an object of definitions"] };
  for (const [name, def] of Object.entries(value as Record<string, unknown>)) {
    if (!MODE_NAME.test(name) || !def || typeof def !== "object") {
      problems.push(`mode '${name}': not a mode definition`);
      continue;
    }
    const d = def as ModeDefinition;
    if (d.otherwise !== undefined && !VERDICTS.includes(d.otherwise))
      problems.push(`mode '${name}': otherwise is allow, ask or deny`);
    else if (d.asks !== undefined && d.asks !== "allow" && d.asks !== "deny")
      problems.push(`mode '${name}': asks is allow or deny`);
    else {
      modes[name] = d;
      const resolved = resolve(name, modes, problems);
      if (!resolved) delete modes[name];
    }
  }
  return { modes, problems };
}

function resolve(
  name: string,
  custom: Readonly<Record<string, ModeDefinition>>,
  problems: string[],
): ResolvedMode | undefined {
  const merged = flatten(name, custom, new Set(), problems);
  if (!merged) return undefined;
  const folders = merged.folders ?? [];
  const askReason = merged.askReason?.replace("{folders}", folders.join(", ") || "no folder");
  return {
    name,
    allow: compile(merged.rules?.allow, folders, problems),
    ask: compile(merged.rules?.ask, folders, problems),
    deny: compile(merged.rules?.deny, folders, problems),
    otherwise: merged.otherwise ?? "ask",
    ...(merged.asks ? { asks: merged.asks } : {}),
    ...(askReason ? { askReason } : {}),
    ...(merged.classifier ? { classifier: true } : {}),
  };
}

/**
 * A definition with its `extends` chain merged (later wins), before compiling; undefined for an
 * unknown mode or a cycle. A definition named as a built-in that extends its own name extends the
 * built-in itself (a deployment changing a built-in mode's settings, such as plan's folders).
 */
function flatten(
  name: string,
  custom: Readonly<Record<string, ModeDefinition>>,
  seen: Set<string>,
  problems: string[],
): ModeDefinition | undefined {
  const def = Object.hasOwn(custom, name)
    ? custom[name]
    : Object.hasOwn(BUILT_IN_MODES, name)
      ? BUILT_IN_MODES[name]
      : undefined;
  if (!def) return undefined;
  if (seen.has(name)) {
    problems.push(`mode '${name}': a cycle of modes`);
    return undefined;
  }
  seen.add(name);
  let base: ModeDefinition = {};
  if (def.extends) {
    const found =
      def.extends === name
        ? flatten(name, {}, new Set(), problems)
        : flatten(def.extends, custom, seen, problems);
    if (!found) {
      problems.push(`mode '${name}': extends an unknown mode '${def.extends}'`);
      return undefined;
    }
    base = found;
  }
  const { extends: _extends, ...own } = def;
  return { ...base, ...own, rules: own.rules ?? base.rules };
}

/** Whether a mode of this name exists, among the built-in ones and the deployment's. */
export const isMode = (name: string, custom: Readonly<Record<string, ModeDefinition>> = {}) =>
  typeof name === "string" &&
  MODE_NAME.test(name) &&
  (Object.hasOwn(custom, name) || Object.hasOwn(BUILT_IN_MODES, name));

/** The mode of this name, resolved; EINVAL for a mode that does not exist. */
export function modeOf(
  name: string,
  custom: Readonly<Record<string, ModeDefinition>> = {},
): ResolvedMode {
  const mode = isMode(name, custom) ? resolve(name, custom, []) : undefined;
  if (!mode) throw codedError("EINVAL", `no mode '${name}'`);
  return mode;
}

/** An action a mode decides: a permission request, and the tool asking, if a tool asks. */
export interface ModeRequest extends AccessRequest {
  tool?: string;
}

/**
 * A tool call as a mode decides it (statewalker/statewalker-root#90, #129): a read tool is a read
 * (`tools.read`), any other a change (`tools.use`); `tool:<name>` rules match its projected name.
 */
export function toolRequest(tool: {
  id: string;
  name: string;
  action: "read" | "write" | "admin";
}): ModeRequest {
  return {
    area: "tools",
    action: tool.action === "read" ? "read" : "use",
    target: tool.id,
    tool: tool.name,
  };
}

export interface ModeDecision {
  verdict: Verdict;
  /** The source of the deciding rule (a layer's, or "mode"); "mode" for its unmatched verdict. */
  source: string;
  reason: string;
}

const matches = (rule: CompiledRule, req: ModeRequest, exact = false) =>
  "tool" in rule
    ? req.tool === rule.tool
    : exact
      ? rule.permission.area === req.area &&
        rule.permission.action === req.action &&
        rule.permission.target === req.target
      : permits([rule.permission], req);

/**
 * Decides one action under a mode and the rules of every layer: deny beats ask, ask beats allow,
 * and an action no rule matches gets the mode's own verdict. In a mode whose `asks` is set, "ask"
 * then becomes that (`bypassPermissions` never asks; `dontAsk` denies instead).
 */
export function decideMode(
  req: ModeRequest,
  { mode, layers }: { mode: ResolvedMode; layers: readonly RuleLayer[] },
): ModeDecision {
  let decision: ModeDecision = matchRules(req, { mode, layers }) ?? {
    verdict: mode.otherwise,
    source: "mode",
    reason: mode.askReason ?? `the ${mode.name} mode's verdict for unmatched actions`,
  };
  if (decision.verdict === "ask" && mode.asks)
    decision = {
      verdict: mode.asks,
      source: decision.source,
      reason: `${mode.name} mode ${mode.asks === "allow" ? "never asks" : "denies instead of asking"}`,
    };
  return decision;
}

/**
 * The decision of the first rule that matches, of the mode's own and every layer's (deny beats
 * ask, ask beats allow); undefined when no rule matches.
 */
export function matchRules(
  req: ModeRequest,
  { mode, layers }: { mode: ResolvedMode; layers: readonly RuleLayer[] },
): ModeDecision | undefined {
  const sources: Record<Verdict, string | undefined> = {
    deny: undefined,
    ask: undefined,
    allow: undefined,
  };
  for (const verdict of VERDICTS) {
    if (mode[verdict].some((r) => matches(r, req))) sources[verdict] ??= "mode";
    for (const layer of layers)
      if (compiledLayer(layer.rules[verdict]).some((r) => matches(r, req, layer.exact)))
        sources[verdict] ??= layer.source;
  }
  const found = VERDICTS.find((v) => sources[v] !== undefined);
  if (!found) return undefined;
  return {
    verdict: found,
    source: sources[found] as string,
    reason: `a ${found} rule of the ${sources[found] === "mode" ? `${mode.name} mode` : sources[found]}`,
  };
}
