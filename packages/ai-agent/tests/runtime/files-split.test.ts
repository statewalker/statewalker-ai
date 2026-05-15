import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  buildFilesSplit,
  isUnderSystem,
  normalizeFolderPath,
  toSystemRelative,
} from "../../src/runtime/files-split.js";

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

describe("isUnderSystem", () => {
  it("returns true for the system path itself", () => {
    expect(isUnderSystem("/.settings", "/.settings")).toBe(true);
  });

  it("returns true for descendants", () => {
    expect(isUnderSystem("/.settings/sessions", "/.settings")).toBe(true);
  });

  it("returns false for siblings", () => {
    expect(isUnderSystem("/sessions", "/.settings")).toBe(false);
    expect(isUnderSystem("/.settings-foo", "/.settings")).toBe(false);
  });
});

describe("toSystemRelative", () => {
  it("returns the default when no override", () => {
    expect(toSystemRelative(undefined, "/.settings", "/sessions")).toBe("/sessions");
  });

  it("rebases an override under systemPath", () => {
    expect(toSystemRelative("/.settings/chats", "/.settings", "/sessions")).toBe("/chats");
  });

  it("returns root when override equals systemPath", () => {
    expect(toSystemRelative("/.settings", "/.settings", "/")).toBe("/");
  });

  it("returns the override unchanged when outside systemPath", () => {
    expect(toSystemRelative("/elsewhere", "/.settings", "/sessions")).toBe("/elsewhere");
  });
});

describe("buildFilesSplit — geometry guard", () => {
  it("throws when systemPath='/' and userPath='/'", () => {
    const root = new MemFilesApi();
    expect(() => buildFilesSplit(root, { systemPath: "/", userPath: "/" })).toThrow(
      /would hide every path/,
    );
  });
});

describe("buildFilesSplit — system view", () => {
  it("rebases system paths under systemPath", async () => {
    const root = new MemFilesApi();
    await writeText(root, "/.settings/sessions/index.json", "[]");
    const { systemFiles } = buildFilesSplit(root, { systemPath: "/.settings", userPath: "/" });
    expect(await systemFiles.exists("/sessions/index.json")).toBe(true);
  });
});

describe("buildFilesSplit — tools view (userPath='/')", () => {
  it("hides the system path-tree", async () => {
    const root = new MemFilesApi();
    await writeText(root, "/.settings/secret.json", "{}");
    await writeText(root, "/work/data.csv", "a,b,c");
    const { toolsFiles } = buildFilesSplit(root, { systemPath: "/.settings", userPath: "/" });
    expect(await toolsFiles.exists("/.settings/secret.json")).toBe(false);
    expect(await toolsFiles.exists("/work/data.csv")).toBe(true);
  });

  it("hides per-subject overrides outside systemPath", async () => {
    const root = new MemFilesApi();
    await writeText(root, "/elsewhere/index.json", "[]");
    const { toolsFiles } = buildFilesSplit(root, {
      systemPath: "/.settings",
      userPath: "/",
      overrides: { sessions: "/elsewhere" },
    });
    expect(await toolsFiles.exists("/elsewhere/index.json")).toBe(false);
  });
});

describe("buildFilesSplit — tools view (userPath subtree)", () => {
  it("rebases at userPath; outside paths are invisible", async () => {
    const root = new MemFilesApi();
    await writeText(root, "/.settings/secret.json", "{}");
    await writeText(root, "/work/data.csv", "a,b,c");
    const { toolsFiles } = buildFilesSplit(root, { systemPath: "/.settings", userPath: "/work" });
    // /work becomes the tools-view root → /data.csv is reachable
    expect(await toolsFiles.exists("/data.csv")).toBe(true);
  });
});

describe("buildFilesSplit — paths object", () => {
  it("returns defaults when no overrides", () => {
    const root = new MemFilesApi();
    const { paths } = buildFilesSplit(root, { systemPath: "/.settings", userPath: "/" });
    expect(paths).toEqual({
      sessions: "/sessions",
      skills: "/skills",
      agents: "/agents",
      config: "/",
    });
  });

  it("rebases an override that lives under systemPath", () => {
    const root = new MemFilesApi();
    const { paths } = buildFilesSplit(root, {
      systemPath: "/.settings",
      userPath: "/",
      overrides: { sessions: "/.settings/chats" },
    });
    expect(paths.sessions).toBe("/chats");
  });

  it("preserves an override that lives outside systemPath", () => {
    const root = new MemFilesApi();
    const { paths } = buildFilesSplit(root, {
      systemPath: "/.settings",
      userPath: "/",
      overrides: { sessions: "/elsewhere" },
    });
    expect(paths.sessions).toBe("/elsewhere");
  });
});
