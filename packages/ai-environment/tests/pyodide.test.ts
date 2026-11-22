// The Pyodide engine's write-back (statewalker/statewalker-root#142), at the engine's interface:
// a run ended while its changes are being written back stops at once, with nothing more written.
// (The conformance suite drives the engine end to end; an abort landing exactly during the
// write-back is not something a scenario can time.)
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { type EngineHost, pyodideEngine } from "../src/pyodide.js";

/** An engine host whose "Pyodide" answers every run with `written` as its changes. */
function fakeHost(written: Record<string, string>): EngineHost {
  return {
    indexURL: "/pyodide/",
    async start(onMessage) {
      return {
        post(m) {
          const msg = m as { type: string; id: number };
          if (msg.type === "init") queueMicrotask(() => onMessage({ type: "ready", version: "x" }));
          if (msg.type === "run")
            queueMicrotask(() =>
              onMessage({
                type: "result",
                id: msg.id,
                stdout: "",
                stderr: "",
                exitCode: 0,
                changes: { written, deleted: [], dirs: [] },
              }),
            );
        },
        kill() {},
      };
    },
  };
}

describe("the Pyodide engine's write-back", () => {
  it("stops at once when the run is ended during it: nothing more is written", async () => {
    const written: Record<string, string> = {};
    for (let i = 0; i < 20; i++) written[`/p/out-${i}.txt`] = `file ${i}`;
    const store = new MemFilesApi();
    await store.write("/p/keep.txt", [new TextEncoder().encode("k")]);
    const controller = new AbortController();
    const writes: string[] = [];
    // The view: the run is ended while its third write is on its way.
    const files = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "write")
          return async (path: string, content: Iterable<Uint8Array>) => {
            writes.push(path);
            if (writes.length === 3) controller.abort(new Error("ELIMIT: refused"));
            return target.write(path, content);
          };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const engine = pyodideEngine(fakeHost(written));
    const instance = await engine.open({ session: "s", files: files as never });
    await expect(
      instance.run(
        { command: "python", args: ["-c", "pass"], cwd: "/p", maxOutput: 1000 },
        controller.signal,
      ),
    ).rejects.toThrow(/ECANCELED/);
    expect(writes.length).toBe(3);
  });
});
