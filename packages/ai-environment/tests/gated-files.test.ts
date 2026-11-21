// The gated file view (statewalker/statewalker-root#80, #122) at its package interface: what one
// holder sees of a workspace. Only the projects the holder is a member of are there, a project's
// system folder is never there under any path form or operation, ignore rules hide files from
// agent sessions only, and every block of a stream is authorized again.
import { codedError } from "@statewalker/ai-access";
import { type FilesApi, readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { type FileAction, type GatedFilesOptions, gatedFiles, ignoreRules } from "../src/index.js";

let store: MemFilesApi;

beforeEach(async () => {
  store = new MemFilesApi();
  const files: Record<string, string> = {
    "/alpha/readme.md": "alpha readme",
    "/alpha/docs/guide.md": "the guide",
    "/alpha/docs/.env": "SECRET=1",
    "/alpha/build/out.js": "built",
    "/alpha/.system/access": '{"ann":"owner"}',
    "/alpha/.system/ignore": "build/\n*.log\n",
    "/alpha/debug.log": "noise",
    "/beta/notes.md": "beta only",
    "/beta/.system/access": '{"bob":"owner"}',
    "/.system/access": '{"root":"admin"}',
  };
  for (const [path, text] of Object.entries(files)) await writeText(store, path, text);
});

/** Ann's view: a member of alpha only, allowed every action anywhere inside it. */
function view(overrides: Partial<GatedFilesOptions> = {}): FilesApi {
  return gatedFiles(store, {
    systemFolder: ".system",
    visible: async (project) => project === "alpha",
    authorize: async (action: FileAction, path: string) => {
      if (!path.startsWith("/alpha/") && path !== "/alpha")
        throw codedError("EACCES", `may not ${action} '${path}'`);
    },
    ...overrides,
  });
}

const listAll = async (files: FilesApi, path: string, recursive = true) => {
  const out: string[] = [];
  for await (const e of files.list(path, { recursive })) out.push(e.path);
  return out.sort();
};

describe("the gated file view", () => {
  it("shows at / only the projects the holder is a member of", async () => {
    expect(await listAll(view(), "/", false)).toEqual(["/alpha"]);
    expect(await view().exists("/beta/notes.md")).toBe(false);
    expect(await view().stats("/beta")).toBeUndefined();
  });

  it("leaves the system folder out of every listing and answers it as absent", async () => {
    const files = view();
    expect(await listAll(files, "/")).toEqual([
      "/alpha",
      "/alpha/build",
      "/alpha/build/out.js",
      "/alpha/debug.log",
      "/alpha/docs",
      "/alpha/docs/.env",
      "/alpha/docs/guide.md",
      "/alpha/readme.md",
    ]);
    for (const path of [
      "/alpha/.system/access",
      "/alpha/./.system/access",
      "/alpha/docs/../.system/access",
      "//alpha//.system//access",
      "/alpha/.SYSTEM/access",
      "/alpha/.System/access",
      "/alpha/.system",
      "/.system/access",
    ]) {
      expect(await files.stats(path)).toBeUndefined();
      expect(await files.exists(path)).toBe(false);
      expect(await readText(files, path)).toBe("");
      expect(await listAll(files, path)).toEqual([]);
      expect(await files.remove(path)).toBe(false);
      await expect(writeText(files, path, "x")).rejects.toThrow(/ENOENT/);
      await expect(files.mkdir(`${path}/sub`)).rejects.toThrow(/ENOENT/);
    }
    expect(await readText(store, "/alpha/.system/access")).toBe('{"ann":"owner"}');
  });

  it("removes a project's files recursively but never its system folder", async () => {
    const files = view();
    expect(await files.remove("/alpha")).toBe(true);
    expect(await listAll(files, "/")).toEqual(["/alpha"]);
    expect(await readText(store, "/alpha/.system/access")).toBe('{"ann":"owner"}');
    expect(await readText(store, "/alpha/.system/ignore")).toBe("build/\n*.log\n");
  });

  it("copies and moves a folder without its system folder, and never into a system folder", async () => {
    const files = view();
    // Into another folder of the project: the system folder is not copied along.
    await writeText(store, "/alpha/docs/.system/kept", "a nested .system is an ordinary folder");
    expect(await files.copy("/alpha/docs", "/alpha/docs2")).toBe(true);
    expect(await readText(files, "/alpha/docs2/guide.md")).toBe("the guide");
    // A folder that would become the project's system folder at the target is refused.
    await expect(files.copy("/alpha/docs", "/alpha")).rejects.toThrow(/ENOENT|EINVAL/);
    await expect(files.move("/alpha/docs2/.system", "/alpha/.system")).rejects.toThrow(/ENOENT/);
    await expect(files.copy("/alpha/readme.md", "/alpha/.system/access")).rejects.toThrow(/ENOENT/);
    await expect(files.move("/alpha/readme.md", "/alpha/.SYSTEM/x")).rejects.toThrow(/ENOENT/);
    // Moving out of the system folder finds nothing to move.
    expect(await files.move("/alpha/.system/access", "/alpha/stolen")).toBe(false);
    expect(await files.copy("/alpha/.system", "/alpha/stolen")).toBe(false);
    expect(await files.exists("/alpha/stolen")).toBe(false);
    expect(await readText(store, "/alpha/.system/access")).toBe('{"ann":"owner"}');
  });

  it("copies a whole project's visible files elsewhere without its system folder", async () => {
    const files = view({
      visible: async (p) => p === "alpha" || p === "beta",
      authorize: async () => {},
    });
    expect(await files.copy("/alpha", "/beta/copy")).toBe(true);
    expect(await store.exists("/beta/copy/.system/access")).toBe(false);
    expect(await readText(files, "/beta/copy/readme.md")).toBe("alpha readme");
    expect(await files.move("/alpha", "/beta/moved")).toBe(true);
    expect(await store.exists("/beta/moved/.system")).toBe(false);
    expect(await readText(store, "/alpha/.system/access")).toBe('{"ann":"owner"}');
    expect(await store.exists("/alpha/readme.md")).toBe(false);
  });

  it("refuses to copy or move a folder onto a folder above it, and changes nothing", async () => {
    const files = view();
    await expect(files.copy("/alpha/docs", "/alpha")).rejects.toThrow(/EINVAL/);
    await writeText(store, "/alpha/docs/sub/x.md", "x");
    for (const op of ["copy", "move"] as const)
      await expect(files[op]("/alpha/docs/sub", "/alpha/docs")).rejects.toThrow(/EINVAL/);
    // Spelled in another case, as a case-insensitive local FS would take it, too.
    await expect(files.copy("/alpha/docs/sub", "/alpha/DOCS")).rejects.toThrow(/EINVAL/);
    await expect(files.move("/alpha/DOCS", "/alpha/docs/sub/in")).rejects.toThrow(/EINVAL/);
    expect(await readText(store, "/alpha/docs/guide.md")).toBe("the guide");
    expect(await readText(store, "/alpha/docs/sub/x.md")).toBe("x");
  });

  it("authorizes every entry an operation touches before changing anything", async () => {
    const files = view({
      authorize: async (action, path) => {
        if (!path.startsWith("/alpha")) throw codedError("EACCES", "outside");
        if (action === "delete" && path === "/alpha/docs/guide.md")
          throw codedError("EACCES", `may not delete ${path}`);
      },
    });
    await expect(files.remove("/alpha/docs")).rejects.toThrow(/EACCES/);
    await expect(files.move("/alpha/docs", "/alpha/elsewhere")).rejects.toThrow(/EACCES/);
    expect(await readText(store, "/alpha/docs/guide.md")).toBe("the guide");
    expect(await store.exists("/alpha/docs/.env")).toBe(true);
    expect(await store.exists("/alpha/elsewhere")).toBe(false);
  });
});

describe("ignore rules", () => {
  const agentView = (deployment = ".env") =>
    view({
      ignoreRules: async (project) =>
        ignoreRules([deployment, await readText(store, `/${project}/.system/ignore`)]),
    });

  it("hide matching files and folders from a holder given them", async () => {
    const files = agentView();
    expect(await listAll(files, "/alpha")).toEqual([
      "/alpha/docs",
      "/alpha/docs/guide.md",
      "/alpha/readme.md",
    ]);
    for (const path of [
      "/alpha/build/out.js",
      "/alpha/build",
      "/alpha/debug.log",
      "/alpha/docs/.env",
    ]) {
      expect(await files.exists(path)).toBe(false);
      expect(await readText(files, path)).toBe("");
      await expect(writeText(files, path, "x")).rejects.toThrow(/ENOENT/);
    }
    expect(await files.remove("/alpha")).toBe(true);
    expect(await readText(store, "/alpha/build/out.js")).toBe("built");
    expect(await readText(store, "/alpha/docs/.env")).toBe("SECRET=1");
  });

  it("hide nothing from a holder without them", async () => {
    expect(await readText(view(), "/alpha/build/out.js")).toBe("built");
    expect(await readText(view(), "/alpha/docs/.env")).toBe("SECRET=1");
  });

  it("only narrow: a negation cannot bring back a file under an ignored folder", async () => {
    const files = view({ ignoreRules: async () => ignoreRules(["build/", "!build/out.js"]) });
    expect(await files.exists("/alpha/build/out.js")).toBe(false);
  });
});

describe("streams", () => {
  it("authorizes every block of a read again, so a revocation stops it at the next block", async () => {
    await store.write("/alpha/big.bin", [new Uint8Array(10_000).fill(7)]);
    let revoked = false;
    let checks = 0;
    const files = view({
      blockSize: 1000,
      authorize: async (_action, path) => {
        checks++;
        if (revoked || !path.startsWith("/alpha")) throw codedError("EACCES", "revoked");
      },
    });
    const got: number[] = [];
    await expect(
      (async () => {
        for await (const block of files.read("/alpha/big.bin")) {
          got.push(block.length);
          if (got.length === 3) revoked = true;
        }
      })(),
    ).rejects.toThrow(/EACCES/);
    expect(got).toEqual([1000, 1000, 1000]);
    expect(checks).toBe(4);
  });

  it("authorizes every block of a write again", async () => {
    let revoked = false;
    const files = view({
      authorize: async (_action, path) => {
        if (revoked || !path.startsWith("/alpha")) throw codedError("EACCES", "revoked");
      },
    });
    async function* content() {
      yield new Uint8Array([1]);
      revoked = true;
      yield new Uint8Array([2]);
    }
    await expect(files.write("/alpha/w.bin", content())).rejects.toThrow(/EACCES/);
  });
});
