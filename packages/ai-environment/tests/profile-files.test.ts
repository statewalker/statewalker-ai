// A user's profile (statewalker/statewalker-root#157): their own folder `profiles/<user>/` of the
// deployment's profiles file system, seen as a FilesApi rooted there. No path form reaches another
// user's folder, and no user name places the folder anywhere else.

import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { mountProfiles, profileFiles } from "../src/index.js";

let profiles: MemFilesApi;

beforeEach(async () => {
  profiles = new MemFilesApi();
  await writeText(profiles, "/profiles/ann/preferences/entries/p1.md", "ann's preference");
  await writeText(profiles, "/profiles/bob/preferences/entries/p1.md", "bob's preference");
  await writeText(profiles, "/profiles/annabel/preferences/entries/p1.md", "annabel's preference");
});

const listAll = async (files: ReturnType<typeof profileFiles>, path = "/") => {
  const paths: string[] = [];
  for await (const e of files.list(path, { recursive: true })) paths.push(e.path);
  return paths.sort();
};

describe("profile files", () => {
  it("shows a user's own profile folder as the root", async () => {
    const ann = profileFiles(profiles, "ann");
    expect(await readText(ann, "/preferences/entries/p1.md")).toBe("ann's preference");
    expect(await listAll(ann)).toEqual([
      "/preferences",
      "/preferences/entries",
      "/preferences/entries/p1.md",
    ]);
    await writeText(ann, "projects/default/alpha/entries/u1.md", "note");
    expect(await readText(profiles, "/profiles/ann/projects/default/alpha/entries/u1.md")).toBe(
      "note",
    );
  });

  it("never reaches another user's profile, under any path form", async () => {
    const ann = profileFiles(profiles, "ann");
    for (const path of [
      "/../bob/preferences/entries/p1.md",
      "../bob/preferences/entries/p1.md",
      "/preferences/../../bob/preferences/entries/p1.md",
      "/profiles/bob/preferences/entries/p1.md",
      "/../annabel/preferences/entries/p1.md",
    ]) {
      expect(await ann.exists(path)).toBe(false);
      expect(await readText(ann, path).catch(() => "")).toBe("");
    }
    expect(await listAll(ann, "/..")).not.toContainEqual(expect.stringContaining("bob"));
    await writeText(ann, "../bob/preferences/entries/p1.md", "overwritten?");
    await ann.remove("/../bob");
    expect(await readText(profiles, "/profiles/bob/preferences/entries/p1.md")).toBe(
      "bob's preference",
    );
  });

  it("refuses a user name that is not one path segment", () => {
    for (const user of ["", ".", "..", "../bob", "ann/../bob", "ann/x", "a\0b"])
      expect(() => profileFiles(profiles, user)).toThrow(/EINVAL/);
  });
});

describe("profiles backend", () => {
  const noDb = () => {
    throw new Error("no database for this backend");
  };

  it("mounts the profiles file system from the configured backend", async () => {
    const memory = await mountProfiles("memory", noDb);
    await writeText(profileFiles(memory, "ann"), "/x.md", "kept in memory");
    expect(await readText(memory, "/profiles/ann/x.md")).toBe("kept in memory");
    await expect(mountProfiles("floppy", noDb)).rejects.toThrow(/EINVAL/);
  });

  it("mounts SqlFs on a Durable Object's SQLite by default, kept across mounts", async () => {
    const storage = newFakeDoStorage();
    const first = await mountProfiles(undefined, () => newDoSqliteDb(storage));
    await writeText(profileFiles(first, "ann"), "/x.md", "kept in SQLite");
    const again = await mountProfiles("sql", () => newDoSqliteDb(storage));
    expect(await readText(again, "/profiles/ann/x.md")).toBe("kept in SQLite");
  });
});
