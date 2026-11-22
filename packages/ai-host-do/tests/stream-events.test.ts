// A write stream of the files-RPC protocol spans several calls, each its own event of the
// Workspace DO, but its FilesApi write runs as continuations of the call that opened it. CellD
// refuses storage transactions to continuations of an event that has ended, so the opening event
// is kept alive until the stream ends (statewalker/statewalker-root#141).
import { describe, expect, it } from "vitest";
import { keepStreamEventsAlive } from "../src/stream-events.js";

function harness() {
  const kept: Promise<unknown>[] = [];
  const calls: [string, unknown[]][] = [];
  let next = 0;
  const call = async (_holder: string, method: string, args: unknown[]) => {
    calls.push([method, args]);
    if (method === "openWrite") return { streamId: `s${++next}` };
    if (method === "closeWrite" && args[0] === "bad") throw new Error("EIO");
    return undefined;
  };
  const held = keepStreamEventsAlive(call as never, (p) => kept.push(p));
  const wrapped = (method: string, args: unknown[]) => held("ann", method as never, args);
  const settled = async (p: Promise<unknown>) => {
    let done = false;
    void p.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    return done;
  };
  return { kept, calls, wrapped, held, settled };
}

describe("the events of a write stream", () => {
  it("keeps the opening call's event alive until the stream is closed", async () => {
    const { kept, wrapped, settled } = harness();
    const opened = (await wrapped("openWrite", ["/p/a"])) as { streamId: string };
    expect(kept).toHaveLength(1);
    expect(await settled(kept[0] as Promise<unknown>)).toBe(false);
    await wrapped("writeChunk", [opened.streamId, 0, new Uint8Array(1)]);
    expect(await settled(kept[0] as Promise<unknown>)).toBe(false);
    await wrapped("closeWrite", [opened.streamId, 1]);
    expect(await settled(kept[0] as Promise<unknown>)).toBe(true);
  });

  it("ends it when the stream is aborted, or its close fails", async () => {
    const { kept, wrapped, settled } = harness();
    const a = (await wrapped("openWrite", ["/p/a"])) as { streamId: string };
    await wrapped("abortWrite", [a.streamId]);
    expect(await settled(kept[0] as Promise<unknown>)).toBe(true);
    const failing = keepStreamEventsAlive(
      (async (_holder: string, method: string) =>
        method === "openWrite" ? { streamId: "bad" } : Promise.reject(new Error("EIO"))) as never,
      (p) => kept.push(p),
    );
    await failing("ann", "openWrite", ["/p/b"]);
    await expect(failing("ann", "closeWrite", ["bad", 0])).rejects.toThrow("EIO");
    expect(await settled(kept[1] as Promise<unknown>)).toBe(true);
  });

  it("ends it once the stream has been idle for the given time", async () => {
    const kept: Promise<unknown>[] = [];
    const wrapped = keepStreamEventsAlive(
      (async () => ({ streamId: "s" })) as never,
      (p) => kept.push(p),
      { idleMs: 5 },
    );
    await wrapped("ann", "openWrite", ["/p/a"]);
    await expect(kept[0]).resolves.toBeUndefined();
  });

  it("passes every other call through unchanged", async () => {
    const { kept, calls, wrapped } = harness();
    expect(await wrapped("stats", ["/p/a"])).toBeUndefined();
    expect(kept).toHaveLength(0);
    expect(calls).toEqual([["stats", ["/p/a"]]]);
  });

  it("keeps the streams of different holders apart", async () => {
    const { kept, held, settled } = harness();
    const a = (await held("ann", "openWrite", ["/p/a"])) as { streamId: string };
    await held("bob", "closeWrite", [a.streamId, 0]);
    expect(await settled(kept[0] as Promise<unknown>)).toBe(false);
    await held("ann", "closeWrite", [a.streamId, 0]);
    expect(await settled(kept[0] as Promise<unknown>)).toBe(true);
  });
});
