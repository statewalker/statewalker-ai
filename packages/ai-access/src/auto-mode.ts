// `auto` mode (statewalker/statewalker-root#96, built by #137): a fixed order of decisions, first
// match wins.
//   1. The permission rules of the deployment, the project, the user and the session (deny beats
//      ask, ask beats allow), with broad allow rules set aside while `auto` is on.
//   2. Fixed safe classes, with no classifier: reads and lists inside the capability, and writes
//      inside the session's project outside protected paths (`.agents/`, `.git/`, and the paths the
//      deployment names).
//   3. Everything else goes to the risk classifier (./classifier.ts).
import {
  type ModeDecision,
  type ModeRequest,
  matchRules,
  type ResolvedMode,
  type RuleLayer,
} from "./modes.js";

/** Which step of `auto` decided an action. */
export type AutoStep = "rule" | "safe" | "classifier";

export type AutoDecision =
  | (ModeDecision & { step: "rule" | "safe" })
  | { step: "classifier"; reason: string };

/** Folder names protected wherever they are in the project. */
const PROTECTED_NAMES = [".agents", ".git"];

/** Interpreters and shells: allowing one of them by name allows running anything. */
const INTERPRETERS = new Set([
  "*",
  "bash",
  "sh",
  "zsh",
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "ruby",
  "perl",
  "run",
]);

const EVERYTHING = new Set(["*", "**", "/", "/*", "/**", "**/*", "/**/*"]);

/**
 * Whether an allow rule is broad: it names every area or action (`*`), no target or a target
 * that matches everything, or an interpreter or every tool by name. Broad allow rules are set
 * aside while `auto` is on, so the classifier still sees what they would let through.
 */
export function isBroadRule(entry: string): boolean {
  if (entry.startsWith("tool:")) return INTERPRETERS.has(entry.slice(5).toLowerCase());
  const colon = entry.indexOf(":");
  const head = colon < 0 ? entry : entry.slice(0, colon);
  const target = colon < 0 ? undefined : entry.slice(colon + 1);
  const [area, action] = head.split(".");
  if (area === "*" || action === "*") return true;
  if (target === undefined || EVERYTHING.has(target.trim())) return true;
  // A target that is only wildcards and slashes matches everything too.
  return /^[/*]+$/.test(target);
}

/** The layers with their broad allow rules set aside. */
export function withoutBroadAllows(layers: readonly RuleLayer[]): RuleLayer[] {
  return layers.map((layer) =>
    layer.rules.allow?.some(isBroadRule)
      ? {
          ...layer,
          rules: { ...layer.rules, allow: layer.rules.allow.filter((e) => !isBroadRule(e)) },
        }
      : layer,
  );
}

/**
 * Whether a path (relative to the project) is protected: inside a folder named `.agents` or
 * `.git` anywhere, or at or under a path the deployment names (case-insensitive).
 */
export function isProtectedPath(path: string, named: readonly string[] = []): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  if (segments.some((s) => PROTECTED_NAMES.includes(s))) return true;
  return named.some((entry) => {
    const p = `/${entry.toLowerCase().split("/").filter(Boolean).join("/")}`;
    if (p === "/") return true;
    return lower === p || lower.startsWith(`${p}/`);
  });
}

/** The safe class an action belongs to, if any: why it needs no classifier. */
function safeClass(req: ModeRequest, protectedPaths: readonly string[]): string | undefined {
  if (req.area === "files" && (req.action === "read" || req.action === "list"))
    return "a read inside the capability";
  if (req.area === "files" && req.action === "write" && req.target !== undefined)
    return isProtectedPath(req.target, protectedPaths)
      ? undefined
      : "a write inside the project, outside protected paths";
  if (req.area === "db" && req.action === "read") return "a read inside the capability";
  if (req.area === "tools" && req.action === "read") return "a tool whose action is read";
  return undefined;
}

/**
 * Decides one action in a classifier mode, up to the classifier: the rules (broad allows set
 * aside), then the safe classes; `{step: "classifier"}` for the rest. The mode's own allow rules
 * count as safe classes where an action is one (they are what `default` allows).
 */
export function decideAuto(
  req: ModeRequest,
  {
    mode,
    layers,
    protectedPaths = [],
  }: { mode: ResolvedMode; layers: readonly RuleLayer[]; protectedPaths?: readonly string[] },
): AutoDecision {
  const ruled = matchRules(req, { mode, layers: withoutBroadAllows(layers) });
  const safe = safeClass(req, protectedPaths);
  if (ruled && !(ruled.source === "mode" && ruled.verdict === "allow" && safe))
    return { ...ruled, step: "rule" };
  if (safe) return { step: "safe", verdict: "allow", source: "safe", reason: safe };
  return {
    step: "classifier",
    reason: `no rule or safe class settles it in ${mode.name} mode`,
  };
}
