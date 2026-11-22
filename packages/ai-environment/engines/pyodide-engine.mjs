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
//                  {type: "fetched", id, response?: {status, url, headers, body: base64}, error?}
//   engine → host  {type: "ready", version} | {type: "failed", error}
//                  {type: "result", id, stdout, stderr, exitCode, changes}
//                  {type: "fetch", id, request: {url, method, headers, body?: base64}}
// Network (statewalker/statewalker-root#208): the engine has no network of its own (no fetch, no
// WebSocket, raw sockets refused, Pyodide's Node socket layer locked); `pyodide.http.pyfetch` asks
// the host, which sends the request through the egress gateway. Scripts may use top-level await.
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
  closeSockets();
  installFetch();
  return pyodide.version;
}

/**
 * Raw sockets stay closed: Emscripten's socket layer refuses every socket (Python's `socket` raises
 * PermissionError), and Pyodide's opt-in Node socket layer (which would reach `node:net`) cannot be
 * turned on from Python. Both are fixed in place, so code cannot put them back.
 */
function closeSockets() {
  const refuse = () => {
    throw new pyodide.FS.ErrnoError(63);
  };
  const SOCKFS = pyodide._module?.SOCKFS;
  if (SOCKFS)
    for (const n of ["createSocket", "pollAsync"])
      Object.defineProperty(SOCKFS, n, { value: refuse, writable: false, configurable: false });
  if (pyodide._api)
    Object.defineProperty(pyodide._api, "initializeNodeSockFS", {
      value: () => Promise.reject(new Error("EACCES: no raw sockets")),
      writable: false,
      configurable: false,
    });
}

// Requests waiting on the host's answer, by id.
let nextFetch = 0;
const fetching = new Map();

/** `pyodide.http.pyfetch` over the host's egress gateway: plain JSON text across. */
function installFetch() {
  pyodide.registerJsModule("_harness_egress", {
    send: (requestJson) =>
      new Promise((resolve, reject) => {
        const id = ++nextFetch;
        fetching.set(id, { resolve, reject });
        send({ type: "fetch", id, request: JSON.parse(requestJson) });
      }),
  });
  pyodide.runPython(FETCH_SHIM);
}

const FETCH_SHIM = `
import base64 as _b64, json as _json, sys as _sys
import pyodide.http as _http
import _harness_egress

class FetchResponse:
    """What pyfetch answers, from the egress gateway: status, url, headers and the body."""
    def __init__(self, r):
        self.status = r["status"]
        self.ok = 200 <= self.status < 300
        self.status_text = ""
        self.url = r["url"]
        self.headers = dict(r["headers"])
        self.redirected = False
        self.type = "basic"
        self._body = _b64.b64decode(r["body"])
        self.body_used = False
    def _take(self):
        if self.body_used:
            raise OSError("the body was already read")
        self.body_used = True
        return self._body
    async def bytes(self):
        return self._take()
    async def memoryview(self):
        return memoryview(self._take())
    async def string(self):
        return self._take().decode()
    async def text(self):
        return self._take().decode()
    async def json(self, **kwargs):
        return _json.loads(self._take().decode(), **kwargs)
    def raise_for_status(self):
        if not self.ok:
            raise OSError(f"{self.status} for url: {self.url}")
    def clone(self):
        c = FetchResponse({"status": self.status, "url": self.url, "headers": self.headers, "body": ""})
        c._body = self._body
        return c

async def pyfetch(url, /, *, method="GET", headers=None, body=None, **kwargs):
    if isinstance(body, str):
        body = body.encode()
    request = {"url": str(url), "method": str(method).upper(), "headers": {str(k): str(v) for k, v in dict(headers or {}).items()}}
    if body:
        request["body"] = _b64.b64encode(bytes(body)).decode()
    answer = _json.loads(await _harness_egress.send(_json.dumps(request)))
    if "error" in answer:
        raise OSError(answer["error"])
    return FetchResponse(answer["response"])

_http.pyfetch = pyfetch
_http.FetchResponse = FetchResponse
`;

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
import sys, os, importlib, ast, inspect, builtins
# The interpreter as it was before any run: each run ends by going back to it, so nothing one run
# imported, put on the path or in the environment reaches the next (an edited module is read anew).
_BASE_MODULES = set(sys.modules)
_BASE_PATH = list(sys.path)
_BASE_ENV = dict(os.environ)
def _reset():
    for name in [m for m in sys.modules if m not in _BASE_MODULES]:
        del sys.modules[name]
    sys.path[:] = _BASE_PATH
    os.environ.clear()
    os.environ.update(_BASE_ENV)
    importlib.invalidate_caches()
async def _exec(source, filename, globs):
    # Top-level await is allowed, as in Pyodide's own console (pyfetch is async).
    code = compile(source, filename, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    result = eval(code, globs)
    if inspect.iscoroutine(result):
        await result
async def _run(argv, cwd):
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
            await _exec(argv[1], "<string>", {"__name__": "__main__", "__builtins__": builtins})
        elif argv[0] == "-":
            sys.argv = ["-", *argv[1:]]
            await _exec(sys.stdin.read(), "<stdin>", {"__name__": "__main__", "__builtins__": builtins})
        elif argv[0].startswith("-"):
            print(f"python: the option {argv[0]} is not supported here", file=sys.stderr)
            return 2
        else:
            sys.argv = list(argv)
            path = os.path.abspath(argv[0])
            sys.path.insert(0, os.path.dirname(path))
            with open(path, encoding="utf-8") as f:
                source = f.read()
            await _exec(source, path, {"__name__": "__main__", "__file__": path, "__builtins__": builtins})
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
        _reset()
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
    exitCode = Number(await runner(argv, cwd)) || 0;
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
  else if (m.type === "fetched") {
    const waiting = fetching.get(m.id);
    if (!waiting) return;
    fetching.delete(m.id);
    waiting.resolve(
      JSON.stringify(m.error ? { error: String(m.error) } : { response: m.response }),
    );
  }
});
