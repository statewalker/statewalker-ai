// Executors (statewalker/statewalker-root#142, decided in #94): the places an agent session's code
// runs, each of one kind, reaching files only through the session's capability.
//
//   shell    just-bash, in the agent's cell (Flue's `bash` tool over the gated view)
//   isolate  a Worker Loader isolate per run: `node` scripts, bundled on the fly, and tool bundles
//   engine   Pyodide or Wasmer, where the runtime's host installed one (./code-engines.ts)
//   pool     an external executor pool: an interface only (`ExecutorPool`); not built yet
//
// The agent sees one `bash` tool; `node`, `python` and the WASIX programs the deployment lists are
// commands inside it, routed here to the executor the deployment picked for that kind of code
// (`EXECUTORS`). Neither the user nor the model picks an engine. Where nothing fits, the answer is
// ENOSYS, never a weaker engine. An agent declares what it needs (`requires: [python, node]`), and
// its session refuses to start when a requirement isn't met.
import { codedError } from "@statewalker/ai-access";
import type {
  CodeEngine,
  CodeEngines,
  EngineFetchRequest,
  EngineFetchResponse,
} from "./code-engines.js";

/** The kinds of code the `bash` tool routes to an executor. */
export type CodeKind = "node" | "python" | "posix";
export const CODE_KINDS: readonly CodeKind[] = ["node", "python", "posix"];

export type ExecutorKind = "shell" | "isolate" | "engine" | "pool";

/** The executor one kind of code runs on, as the deployment picked it. */
export type Executor =
  | { kind: "isolate" }
  | { kind: "engine"; engine: keyof CodeEngines; instance: CodeEngine }
  | { kind: "pool" };

/** The commands of the `bash` tool that are code of a kind, besides the deployment's programs. */
const COMMANDS: Readonly<Record<string, CodeKind>> = {
  node: "node",
  nodejs: "node",
  python: "python",
  python3: "python",
};

/** What the deployment offers, for each kind of code, and the WASIX programs routed as `posix`. */
export interface ExecutorPlan {
  executors: Partial<Record<CodeKind, Executor>>;
  /** Why a kind has no executor, for its ENOSYS. */
  missing: Partial<Record<CodeKind, string>>;
  /** POSIX programs (WASIX) the `bash` tool routes to the `posix` executor. */
  programs: string[];
  problems: string[];
}

const CHOICES: Readonly<Record<CodeKind, readonly string[]>> = {
  node: ["isolate", "pool", "off"],
  python: ["pyodide", "wasmer", "pool", "off"],
  posix: ["wasmer", "pool", "off"],
};

const PROGRAM = /^[a-z0-9][a-z0-9._+-]{0,63}$/i;

/**
 * The deployment's executors (`EXECUTORS`: `{"node"?, "python"?, "posix"?, "programs"?}`, each
 * kind `isolate` (node), `pyodide` or `wasmer` (an engine), `pool` or `off`), over what this
 * runtime offers: a Worker Loader (`isolate`) and the engines its host installed. A kind the
 * deployment leaves out takes the default: `node` the isolate, `python` Pyodide (else Wasmer's
 * CPython), `posix` Wasmer, each where offered. A choice the runtime does not offer is reported
 * and leaves the kind without an executor.
 */
export function parseExecutors(
  value: unknown,
  offered: { isolate: boolean; engines: CodeEngines },
): ExecutorPlan {
  const problems: string[] = [];
  let config: Record<string, unknown> = {};
  if (typeof value === "string" && value.trim()) {
    try {
      config = JSON.parse(value);
    } catch {
      problems.push("EXECUTORS is not JSON");
    }
  } else if (value && typeof value === "object") config = value as Record<string, unknown>;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    problems.push("EXECUTORS is a JSON object");
    config = {};
  }
  const serves = (name: keyof CodeEngines, program: string) =>
    !!offered.engines[name]?.programs.includes(program);
  const defaults: Record<CodeKind, string> = {
    node: offered.isolate ? "isolate" : "off",
    python: serves("pyodide", "python") ? "pyodide" : serves("wasmer", "python") ? "wasmer" : "off",
    posix: offered.engines.wasmer ? "wasmer" : "off",
  };
  const plan: ExecutorPlan = { executors: {}, missing: {}, programs: [], problems };
  for (const kind of CODE_KINDS) {
    const asked = config[kind];
    let choice = defaults[kind];
    if (asked !== undefined) {
      if (typeof asked === "string" && CHOICES[kind].includes(asked)) choice = asked;
      else problems.push(`EXECUTORS.${kind} is one of ${CHOICES[kind].join(", ")}`);
    }
    if (choice === "off") {
      plan.missing[kind] =
        asked === "off"
          ? `${kind} is off in this deployment`
          : `this runtime has no executor for ${kind}`;
      continue;
    }
    if (choice === "pool") {
      plan.missing[kind] = `the external executor pool for ${kind} is not available yet`;
      continue;
    }
    if (choice === "isolate") {
      if (offered.isolate) plan.executors[kind] = { kind: "isolate" };
      else {
        plan.missing[kind] = "this runtime has no Worker Loader";
        problems.push("EXECUTORS.node: no Worker Loader here");
      }
      continue;
    }
    const engine = choice as keyof CodeEngines;
    const instance = offered.engines[engine];
    if (instance) plan.executors[kind] = { kind: "engine", engine, instance };
    else {
      plan.missing[kind] = `this runtime has no ${engine} engine`;
      if (asked !== undefined) problems.push(`EXECUTORS.${kind}: no ${engine} engine here`);
    }
  }
  const programs = config.programs;
  if (programs !== undefined) {
    if (!Array.isArray(programs) || programs.some((p) => typeof p !== "string" || !PROGRAM.test(p)))
      problems.push("EXECUTORS.programs is a list of program names");
    else
      plan.programs = [...new Set(programs as string[])].filter(
        (p) => !(p in COMMANDS) && p !== "bash" && p !== "sh",
      );
  }
  return plan;
}

/** The kind of code a command of the `bash` tool is, or undefined for the shell's own. */
export function codeKindOf(
  command: string,
  plan: Pick<ExecutorPlan, "programs">,
): CodeKind | undefined {
  return COMMANDS[command] ?? (plan.programs.includes(command) ? "posix" : undefined);
}

/** The commands the `bash` tool routes to executors. */
export function routedCommands(plan: Pick<ExecutorPlan, "programs">): string[] {
  return [...Object.keys(COMMANDS), ...plan.programs];
}

/** The ENOSYS a kind of code without an executor answers. */
export function noExecutor(plan: ExecutorPlan, kind: CodeKind) {
  return codedError("ENOSYS", plan.missing[kind] ?? `this runtime has no executor for ${kind}`);
}

/** What `requires` may name besides the kinds of code: always met (the shell is everywhere). */
const ALWAYS = new Set(["shell", "bash"]);

/**
 * The requirements an agent's `requires` names: a list (`[python, node]`), a comma-separated
 * string, or an object whose keys name them (`network` is the egress gateway's, #208, and is not a
 * requirement to start).
 */
export function requirementsOf(requires: unknown): string[] {
  if (requires === undefined || requires === null || requires === "") return [];
  const list =
    typeof requires === "string"
      ? requires.split(",")
      : Array.isArray(requires)
        ? requires
        : typeof requires === "object"
          ? Object.entries(requires as Record<string, unknown>)
              .filter(([key, v]) => key !== "network" && v !== false && v !== null)
              .map(([key]) => key)
          : [String(requires)];
  return [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
}

/**
 * Why an agent's session cannot start here (its first unmet requirement, as a sentence), or
 * undefined when every requirement is met.
 */
export function unmetRequirement(
  agent: string,
  requires: unknown,
  plan: ExecutorPlan,
): string | undefined {
  for (const name of requirementsOf(requires)) {
    if (ALWAYS.has(name)) continue;
    const kind = (name === "nodejs" ? "node" : name === "python3" ? "python" : name) as CodeKind;
    if (!CODE_KINDS.includes(kind))
      return `the agent ${agent} requires '${name}', which this harness does not know`;
    if (!plan.executors[kind])
      return `the agent ${agent} requires ${kind}, which this deployment cannot run: ${plan.missing[kind] ?? "no executor"}`;
  }
  return undefined;
}

/** One run of code, as the `bash` tool asks for it. */
export interface ExecRequest {
  command: string;
  args: string[];
  /** The working directory, a path of the session's file view. */
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Keeps at most `max` characters of a stream, saying what was cut. */
export function capOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[output cut at ${max} characters]\n`;
}

/** How long a killed run's work is waited on to stop. */
const KILL_GRACE_MS = 5_000;

/** How often a running executor's time is charged. */
const SLICE_MS = 100;

/**
 * Runs `work` metered: its time is charged in slices as it goes (`charge`, which throws ELIMIT to
 * end it), and it is ended at `timeoutMs`. An ended run's signal aborts, and the answer is the
 * reason at once (the work may still settle later; nothing it does then is waited on). The time
 * left once it ended is recorded (`record`, never refused).
 */
export async function runMetered<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: {
    timeoutMs: number;
    charge(ms: number): Promise<unknown>;
    record(ms: number): Promise<unknown>;
    signal?: AbortSignal;
  },
): Promise<{ value: T; ms: number } | { killed: string; ms: number }> {
  const controller = new AbortController();
  const started = Date.now();
  let charged = 0;
  let charging: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const ended = new Promise<string>((resolve) => {
    deadline = setTimeout(
      () => resolve(`ETIMEDOUT: the run took longer than ${options.timeoutMs} ms`),
      options.timeoutMs,
    );
    onAbort = () => resolve("ECANCELED: the run was cancelled");
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setInterval(() => {
      if (charging) return;
      const slice = Date.now() - started - charged;
      if (slice <= 0) return;
      charging = options.charge(slice).then(
        () => {
          charged += slice;
          charging = undefined;
        },
        (e) => {
          // A refused slice was spent all the same: it is recorded once the run ended.
          charging = undefined;
          resolve(String((e as Error)?.message ?? e));
        },
      );
    }, SLICE_MS);
  });
  try {
    const working = work(controller.signal);
    const outcome = await Promise.race([
      working.then((value) => ({ value })),
      ended.then((killed) => ({ killed })),
    ]);
    if ("killed" in outcome) {
      controller.abort(new Error(outcome.killed));
      // The work is told to stop: its answer waits until it has (a write-back stops at its next
      // step), or a short grace passes, so nothing it does lands after the run was reported ended.
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        working.catch(() => {}),
        new Promise((r) => {
          grace = setTimeout(r, KILL_GRACE_MS);
        }),
      ]);
      clearTimeout(grace);
    }
    return { ...outcome, ms: Date.now() - started };
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    await charging;
    const rest = Date.now() - started - charged;
    if (rest > 0) await options.record(rest).catch(() => {});
  }
}

/**
 * The external executor pool (decided in #94; built in a later step): Wasmer runners outside the
 * deployment, for `python` and POSIX programs where no local engine runs (CellD, Workers). A run
 * takes a lease; the pool gets a lease-scoped, attenuated token that expires with the lease, and
 * reaches the session's files through the Workspace's token-checked network edge (`PoolMount`).
 */
export interface ExecutorPool {
  /** A lease for one agent session's runs of these kinds of code. */
  lease(request: { session: string; kinds: CodeKind[]; ttlMs: number }): Promise<PoolLease>;
  /** Runs one program under a lease. */
  run(lease: PoolLease, request: ExecRequest, signal: AbortSignal): Promise<ExecResult>;
  /** Ends a lease: its token stops working at once. */
  release(lease: PoolLease): Promise<void>;
}

export interface PoolLease {
  id: string;
  /** The attenuated token the pool presents at the Workspace's edge; it expires with the lease. */
  token: string;
  /** When the lease (and its token) expires, in ms since the epoch. */
  expires: number;
}

/**
 * The mount protocol a pool runner speaks back to the Workspace's edge: the files-RPC methods,
 * each call carrying the lease's token and checked live by the gate.
 */
export interface PoolMount {
  call(token: string, method: string, args: unknown[]): Promise<unknown>;
  /**
   * The runner's only network (statewalker/statewalker-root#208): a pool executor has no internet
   * of its own and sends each request back over its lease channel, with the lease's token, to the
   * egress gateway, which decides and sends it as for any executor.
   */
  egress(token: string, request: EngineFetchRequest): Promise<EngineFetchResponse>;
}
