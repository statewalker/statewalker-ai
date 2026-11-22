// The Python engine (statewalker/statewalker-root#142, decided in #94): Pyodide (CPython on
// WebAssembly) in a realm of its own, never the harness's.
//   Node:    a child process started with Node's permission model (it may read only Pyodide's
//            files and this script: no writes, no child processes, no workers) and with code
//            generation from strings disabled; its environment is empty.
//   Browser: a module Worker; after Pyodide has loaded, the network and storage APIs are removed
//            from its global scope.
// It never holds the capability. It talks to its host by messages:
//   host → engine  {type: "init", indexURL}
//                  {type: "run", id, files: {"/proj/a.txt": content}, cwd, args, stdin}
//   engine → host  {type: "ready", version} | {type: "failed", error}
//                  {type: "result", id, stdout, stderr, exitCode, changes}
// Files: before a run the host copies the readable files of the session's project in; after the
// run the engine reports what changed, and the host writes it back through the session's file
// view, so every change is authorized again. A content is UTF-8 text, or {$b64} for other bytes.
const IN_NODE = typeof process === "object" && !!process.versions?.node && !globalThis.window;

let send;
let onMessage;
if (IN_NODE) {
  send = (m) => process.send?.(m);
  onMessage = (fn) => process.on("message", fn);
  process.on("disconnect", () => process.exit(0));
} else {
  send = (m) => self.postMessage(m);
  onMessage = (fn) => self.addEventListener("message", (e) => fn(e.data));
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const toB64 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const contentOf = (raw) => {
  try {
    return utf8.decode(raw);
  } catch {
    return { $b64: toB64(raw) };
  }
};
const same = (a, b) =>
  typeof a === "string" || typeof b === "string" ? a === b : a?.$b64 === b?.$b64;

let pyodide;
const out = { stdout: [], stderr: [] };
let stdinText = "";

async function init(indexURL) {
  let loadPyodide;
  if (IN_NODE) {
    // Pyodide's Node file system asks process.binding("constants"), which the permission model
    // refuses: give it exactly those constants.
    const { constants } = await import("node:fs");
    process.binding = (name) => {
      if (name === "constants") return { fs: constants };
      throw new Error("process.binding is not available");
    };
    ({ loadPyodide } = await import(new URL("pyodide.mjs", `file://${indexURL}`).href));
  } else {
    ({ loadPyodide } = await import(
      new URL("pyodide.mjs", new URL(indexURL, self.location.href)).href
    ));
  }
  pyodide = await loadPyodide({
    indexURL,
    // The `js` module sees nothing of this realm.
    jsglobals: Object.freeze({}),
    stdout: (s) => out.stdout.push(s),
    stderr: (s) => out.stderr.push(s),
    stdin: () => {
      const s = stdinText;
      stdinText = "";
      return s || null;
    },
  });
  lockdown();
  return pyodide.version;
}

/** After Pyodide has loaded: no network or storage APIs are left in this realm. */
function lockdown() {
  const g = globalThis;
  for (const n of [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "WebTransport",
    "RTCPeerConnection",
    "importScripts",
    "Worker",
    "SharedWorker",
    "BroadcastChannel",
    "indexedDB",
    "caches",
    "Request",
    "Response",
  ]) {
    try {
      delete g[n];
      if (n in g)
        Object.defineProperty(g, n, { value: undefined, configurable: false, writable: false });
    } catch {}
  }
  if (!IN_NODE && g.navigator)
    for (const target of [g.navigator, Object.getPrototypeOf(g.navigator)])
      for (const n of ["storage", "locks", "serviceWorker", "sendBeacon"])
        try {
          Object.defineProperty(target, n, { value: undefined, configurable: false });
        } catch {}
}

/** A fresh tree of the session's files (paths of its view), replacing the last run's. */
function writeTree(files) {
  const FS = pyodide.FS;
  for (const [path, content] of Object.entries(files)) {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    FS.mkdirTree(dir);
    FS.writeFile(path, typeof content === "string" ? content : fromB64(content.$b64));
  }
}

/** What changed under `root` since `before`: written files, deleted files, new directories. */
function changes(root, before) {
  const FS = pyodide.FS;
  const written = {};
  const dirs = [];
  const seen = new Set();
  const walk = (dir) => {
    let names = [];
    try {
      names = FS.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const full = `${dir}/${name}`;
      const mode = FS.stat(full).mode;
      if (FS.isDir(mode)) {
        if (!Object.keys(before).some((p) => p.startsWith(`${full}/`))) dirs.push(full);
        walk(full);
      } else if (FS.isFile(mode)) {
        seen.add(full);
        const content = contentOf(FS.readFile(full));
        if (!same(before[full], content)) written[full] = content;
      }
    }
  };
  walk(root);
  const deleted = Object.keys(before).filter((p) => !seen.has(p));
  return { written, deleted, dirs };
}

/** Removes a tree the last run left. */
function clear(root) {
  pyodide.runPython(`import shutil\nshutil.rmtree(${JSON.stringify(root)}, ignore_errors=True)`);
}

const RUNNER = `
import sys, runpy, os
def _run(argv, cwd):
    os.makedirs(cwd, exist_ok=True)
    os.chdir(cwd)
    if not argv or argv[0] in ("-h", "--help"):
        print("usage: python <script> [arguments] | python -c <code> [arguments]", file=sys.stderr)
        return 2
    try:
        if argv[0] == "-c":
            if len(argv) < 2:
                print("python: -c needs code", file=sys.stderr)
                return 2
            sys.argv = ["-c", *argv[2:]]
            exec(compile(argv[1], "<string>", "exec"), {"__name__": "__main__"})
        elif argv[0] == "-":
            sys.argv = ["-", *argv[1:]]
            exec(compile(sys.stdin.read(), "<stdin>", "exec"), {"__name__": "__main__"})
        elif argv[0].startswith("-"):
            print(f"python: the option {argv[0]} is not supported here", file=sys.stderr)
            return 2
        else:
            sys.argv = list(argv)
            sys.path.insert(0, os.path.dirname(os.path.abspath(argv[0])))
            runpy.run_path(argv[0], run_name="__main__")
        return 0
    except SystemExit as e:
        code = e.code
        if code is None: return 0
        if isinstance(code, int): return code
        print(code, file=sys.stderr)
        return 1
    except BaseException:
        import traceback
        traceback.print_exc()
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
`;

let runner;
async function run({ id, files, cwd, args, stdin, root }) {
  out.stdout.length = 0;
  out.stderr.length = 0;
  stdinText = String(stdin ?? "");
  let exitCode = 1;
  let result = { written: {}, deleted: [], dirs: [] };
  try {
    clear(root);
    writeTree(files);
    if (!runner) {
      pyodide.runPython(RUNNER);
      runner = pyodide.globals.get("_run");
    }
    const argv = pyodide.toPy(args ?? []);
    exitCode = Number(runner(argv, cwd)) || 0;
    argv.destroy?.();
    result = changes(root, files);
  } catch (e) {
    out.stderr.push(String(e?.message ?? e));
  }
  send({
    type: "result",
    id,
    stdout: out.stdout.join("\n") + (out.stdout.length ? "\n" : ""),
    stderr: out.stderr.join("\n") + (out.stderr.length ? "\n" : ""),
    exitCode,
    changes: result,
  });
}

onMessage(async (m) => {
  if (!m || typeof m !== "object") return;
  if (m.type === "init") {
    try {
      send({ type: "ready", version: await init(m.indexURL) });
    } catch (e) {
      send({ type: "failed", error: String(e?.stack ?? e) });
    }
  } else if (m.type === "run") await run(m);
});
