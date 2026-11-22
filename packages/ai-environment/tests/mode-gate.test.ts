// The holder's side of the mode gate (`approvalAware`): a change the gate asks about fails with
// the approval it waits on, and the turn's later changes fail without reaching the gate.
import type { ApprovalRequest } from "@statewalker/ai-access";
import type { FilesApi } from "@statewalker/webrun-files";
import { describe, expect, it } from "vitest";
import { approvalAware, approvalError } from "../src/index.js";

const request = (path: string): ApprovalRequest => ({
  id: `ap-${path.replace(/\W/g, "")}`,
  session: "s1",
  project: "p",
  action: { method: "write", path },
  permission: `files.write:${path}`,
  reason: "the mode asks",
});

/** A view whose every change the gate asks about, each answered once both are in flight. */
function askingView(inFlight: number): { view: FilesApi; reached: string[] } {
  const reached: string[] = [];
  let release = () => {};
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = {
    async write(path: string) {
      reached.push(path);
      if (reached.length >= inFlight) release();
      await all;
      throw approvalError(request(path));
    },
  } as unknown as FilesApi;
  return { view, reached };
}

const bytes = [new TextEncoder().encode("x")];

describe("approvalAware", () => {
  it("names each concurrent change's own approval, also when the same change is tried again", async () => {
    const { view, reached } = askingView(2);
    const asked: string[] = [];
    const files = approvalAware(view, (r) => asked.push(r.id));
    const results = await Promise.allSettled([
      files.write("/p/a.md", bytes),
      files.write("/p/b.md", bytes),
    ]);
    const messages = results.map((r) => String((r as PromiseRejectedResult).reason?.message));
    expect(messages[0]).toContain("ap-pamd");
    expect(messages[1]).toContain("ap-pbmd");
    expect(asked.sort()).toEqual(["ap-pamd", "ap-pbmd"]);
    // Tried again (Flue's write tool retries after creating the folder): its own approval, and
    // the gate is not asked again.
    await expect(files.write("/p/a.md", bytes)).rejects.toThrow(/ap-pamd/);
    await expect(files.write("/p/b.md", bytes)).rejects.toThrow(/ap-pbmd/);
    // Any other change fails on the first approval the turn waits on.
    await expect(files.write("/p/c.md", bytes)).rejects.toThrow(/ap-p[ab]md/);
    expect(reached).toEqual(["/p/a.md", "/p/b.md"]);
  });
});
