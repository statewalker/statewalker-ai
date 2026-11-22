// The code engines of a runtime (statewalker/statewalker-root#142, decided in #94): Pyodide and
// Wasmer where the runtime can confine them (CellB in a browser: a module Worker; CellB on Node: a
// child process under Node's permission model). Whether a runtime has one is a capability its host
// declares by installing it before the deployment starts (`installCodeEngines`), as for the local
// model engine (./local-models.ts); the harness answers ENOSYS where none is installed (CellD,
// workerd), never falling back to a weaker engine.
//
// An engine instance belongs to one agent session: it is opened for the session, never shared
// across sessions or capabilities, and closed when idle or when the session ends. It reaches files
// only through the `files` it is given, the session's gated view, so every operation it makes is
// one the gate decides (Wasmer: forwarded live; Pyodide: copied in, and each change written back
// through the view, authorized again). It has no network.

/** One program run in an engine, as the agent's `bash` asked for it. */
export interface EngineRun {
  /** The program (`python`, `python3`, or a WASIX program the engine offers). */
  command: string;
  args: string[];
  /** The working directory, a path of the session's file view (`/<project>/...`). */
  cwd: string;
  /** What the program reads on its standard input. */
  stdin?: string;
  /** Exported shell variables. */
  env?: Record<string, string>;
  /** The most output kept, per stream, in characters. */
  maxOutput: number;
}

export interface EngineResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The session's file view, as an engine reaches it (a webrun-files FilesApi, structurally). */
export type EngineFiles = {
  read(path: string, options?: { start?: number; length?: number }): AsyncIterable<Uint8Array>;
  write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<unknown> | unknown;
  list(path: string, options?: { recursive?: boolean }): AsyncIterable<unknown>;
  stats(path: string): Promise<unknown>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<unknown> | unknown;
  remove(path: string): Promise<boolean>;
  move(source: string, target: string): Promise<boolean>;
  copy(source: string, target: string): Promise<boolean>;
};

/** An engine opened for one agent session. */
export interface EngineInstance {
  /** Runs one program; `signal` aborts it (a timeout, a refused limit, a cancelled turn). */
  run(run: EngineRun, signal: AbortSignal): Promise<EngineResult>;
  /** Releases the engine (its process or Worker, its memory). */
  close(): Promise<void> | void;
}

/** A code engine of this runtime. */
export interface CodeEngine {
  /** The programs it runs: `python`/`python3` for Pyodide; bash, coreutils, ... for Wasmer. */
  readonly programs: readonly string[];
  /** Opens an instance for one agent session over its file view. */
  open(options: {
    session: string;
    files: EngineFiles;
    /** The memory cap, in MiB, where the runtime can hold an engine to one. */
    memoryMb?: number;
  }): Promise<EngineInstance>;
}

/** The engines a runtime offers, by name. */
export interface CodeEngines {
  pyodide?: CodeEngine;
  wasmer?: CodeEngine;
}

const KEY = Symbol.for("@statewalker/ai-environment/code-engines");
type Holder = { [KEY]?: CodeEngines };

/**
 * Declares this runtime's code engines (the host calls it before it starts the deployment);
 * `undefined` withdraws them. Held on the realm's global object, so a deployment bundled with its
 * own copy of this package finds them.
 */
export function installCodeEngines(engines: CodeEngines | undefined): void {
  const g = globalThis as Holder;
  if (engines) g[KEY] = engines;
  else delete g[KEY];
}

/** This runtime's code engines, as its host installed them (none: `{}`). */
export function codeEngines(): CodeEngines {
  return (globalThis as Holder)[KEY] ?? {};
}
