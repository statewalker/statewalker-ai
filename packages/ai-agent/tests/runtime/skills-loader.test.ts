import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it, vi } from "vitest";
import { SkillsLoader } from "../../src/runtime/skills-loader.js";

describe("SkillsLoader.load", () => {
  it("returns manual skills unchanged when the folder is missing", async () => {
    const files = new MemFilesApi();
    const loader = new SkillsLoader();
    const onError = vi.fn();
    const result = await loader.load(
      files,
      "/skills",
      [{ name: "manual-1", description: "manual", content: "body" }],
      onError,
    );
    expect(result).toEqual([{ name: "manual-1", description: "manual", content: "body" }]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns empty when the folder is missing and manual list is empty", async () => {
    const files = new MemFilesApi();
    const loader = new SkillsLoader();
    const result = await loader.load(files, "/skills", [], vi.fn());
    expect(result).toEqual([]);
  });

  it("appends disk skills after manual skills, preserving order", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/skills/disk-1.md",
      "---\nname: disk-1\ndescription: disk skill\n---\nDisk body.",
    );
    const loader = new SkillsLoader();
    const result = await loader.load(
      files,
      "/skills",
      [{ name: "manual-1", description: "manual", content: "body" }],
      vi.fn(),
    );
    expect(result.map((s) => s.name)).toEqual(["manual-1", "disk-1"]);
  });

  it("ignores non-.md files", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/skills/keep.md", "---\nname: keep\ndescription: ok\n---\n");
    await writeText(files, "/skills/readme.txt", "ignore");
    const loader = new SkillsLoader();
    const result = await loader.load(files, "/skills", [], vi.fn());
    expect(result.map((s) => s.name)).toEqual(["keep"]);
  });

  it("routes per-file read errors through onError without aborting", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/skills/valid.md", "---\nname: valid\ndescription: ok\n---\n");
    await writeText(files, "/skills/corrupt.md", "---\nname: corrupt\ndescription: ok\n---\n");
    // Force a read error for one file by stubbing the read method.
    const originalRead = files.read.bind(files);
    files.read = ((path: string) => {
      if (path === "/skills/corrupt.md") {
        async function* fail(): AsyncGenerator<Uint8Array> {
          // Throwing during the first iteration emits the error to consumers.
          yield await Promise.reject(new Error("simulated read failure"));
        }
        return fail();
      }
      return originalRead(path);
    }) as typeof files.read;

    const loader = new SkillsLoader();
    const onError = vi.fn();
    const result = await loader.load(files, "/skills", [], onError);
    expect(result.map((s) => s.name)).toEqual(["valid"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toEqual({ path: "/skills/corrupt.md" });
  });
});
