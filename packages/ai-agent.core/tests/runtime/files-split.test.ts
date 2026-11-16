import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { buildFilesSplit, normalizeFolderPath } from "../../src/runtime/files-split.js";

describe("normalizeFolderPath", () => {
  it("ensures leading slash", () => {
    expect(normalizeFolderPath("foo")).toBe("/foo");
  });

  it("strips trailing slash unless root", () => {
    expect(normalizeFolderPath("/foo/")).toBe("/foo");
    expect(normalizeFolderPath("/")).toBe("/");
  });

  it("idempotent on already-normalised paths", () => {
    expect(normalizeFolderPath("/.settings")).toBe("/.settings");
  });
});

describe("buildFilesSplit — geometry guard", () => {
  it("throws when systemPath='/'", () => {
    const root = new MemFilesApi();
    expect(() => buildFilesSplit(root, { systemPath: "/" })).toThrow(/would hide every path/);
  });
});

describe("buildFilesSplit — system view", () => {
  it("rebases system paths under systemPath", async () => {
    const root = new MemFilesApi();
    await writeText(root, "/.settings/sessions/index.json", "[]");
    const { systemFiles } = buildFilesSplit(root, { systemPath: "/.settings" });
    expect(await systemFiles.exists("/sessions/index.json")).toBe(true);
  });
});

describe("buildFilesSplit — tools view", () => {
  it("hides the system path-tree from tools", async () => {
    const root = new MemFilesApi();
    await writeText(root, "/.settings/secret.json", "{}");
    await writeText(root, "/work/data.csv", "a,b,c");
    const { toolsFiles } = buildFilesSplit(root, { systemPath: "/.settings" });
    expect(await toolsFiles.exists("/.settings/secret.json")).toBe(false);
    expect(await toolsFiles.exists("/work/data.csv")).toBe(true);
  });
});

describe("buildFilesSplit — paths object", () => {
  it("returns hard-coded system-relative defaults", () => {
    const root = new MemFilesApi();
    const { paths } = buildFilesSplit(root, { systemPath: "/.settings" });
    expect(paths).toEqual({
      sessions: "/sessions",
      skills: "/skills",
      agents: "/agents",
      config: "/",
    });
  });
});

// webrun-files 0.12 resolves `..` segments before any filter sees the path
// (statewalker/statewalker-ai#28): a tool cannot reach the system folder by climbing out of
// a visible folder, and a path above the root is refused.
describe("buildFilesSplit — tools view and `..` segments", () => {
  it("hides the system tree when the path climbs into it", async () => {
    const root = new MemFilesApi();
    await writeText(root, "/.settings/secret.json", "{}");
    await writeText(root, "/work/data.csv", "a,b,c");
    const { toolsFiles } = buildFilesSplit(root, { systemPath: "/.settings" });
    expect(await toolsFiles.exists("/work/../.settings/secret.json")).toBe(false);
    expect(await toolsFiles.exists("/work/../work/data.csv")).toBe(true);
  });

  it("does not write into the system tree through a climbing path", async () => {
    const root = new MemFilesApi();
    const { toolsFiles } = buildFilesSplit(root, { systemPath: "/.settings" });
    await expect(writeText(toolsFiles, "/work/../.settings/injected.json", "{}")).rejects.toThrow();
    expect(await root.exists("/.settings/injected.json")).toBe(false);
  });

  it("refuses a path that climbs above the root", async () => {
    const root = new MemFilesApi();
    await writeText(root, "/work/data.csv", "a,b,c");
    const { toolsFiles } = buildFilesSplit(root, { systemPath: "/.settings" });
    await expect(toolsFiles.exists("/../work/data.csv")).rejects.toThrow(/climbs above the root/);
  });
});
