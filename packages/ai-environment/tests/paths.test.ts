// Path normalization, property-based (fast-check): every path the gate sees is normalised first,
// and no path form, however built from `.`, `..`, empty segments and case variants, reaches the
// system folder or above the root.
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { gatedFiles, normalise } from "../src/index.js";

const segment = fc.constantFrom(
  "",
  ".",
  "..",
  "alpha",
  "docs",
  "a.md",
  ".system",
  ".SYSTEM",
  ".System",
  "x",
);
const rawPath = fc
  .array(segment, { maxLength: 8 })
  .chain((segs) =>
    fc.boolean().map((absolute) => `${absolute ? "/" : ""}${segs.join("/")}` || "/"),
  );
/** A segment that changes nothing where it stands: "", ".", or a name followed by "..". */
const noise = fc.constantFrom("", ".", "zz/..", "./.", "q/../.");

describe("path normalization", () => {
  it("gives an absolute path with no empty, '.' or '..' segment, and is idempotent", () => {
    fc.assert(
      fc.property(rawPath, (p) => {
        const n = normalise(p);
        expect(n.startsWith("/")).toBe(true);
        if (n !== "/")
          expect(n.slice(1).split("/")).not.toContainEqual(expect.stringMatching(/^(\.|\.\.|)$/));
        expect(normalise(n)).toBe(n);
      }),
    );
  });

  it("ignores segments that change nothing, wherever they are inserted", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("alpha", "docs", "a.md", ".system"), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.array(noise, { minLength: 6, maxLength: 6 }),
        (names, noises) => {
          const clean = `/${names.join("/")}`;
          const noisy = `/${names.map((n, i) => `${noises[i]}/${n}`).join("/")}/${noises[5]}`;
          expect(normalise(noisy)).toBe(clean);
        },
      ),
    );
  });

  it("never goes above the root: '..' at the root stays at the root", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.constantFrom("alpha", "alpha/docs"),
        (n, rest) => {
          expect(normalise(`${"/..".repeat(n)}/${rest}`)).toBe(`/${rest}`);
        },
      ),
    );
  });

  it("refuses an empty path and a NUL byte", () => {
    expect(() => normalise("")).toThrow(/EINVAL/);
    expect(() => normalise("/alpha/\0/x")).toThrow(/EINVAL/);
  });

  it("never lets any path form reach the system folder through the gate", async () => {
    const store = new MemFilesApi();
    await writeText(store, "/alpha/.system/access", "SECRET-ACCESS");
    await writeText(store, "/alpha/docs/a.md", "doc");
    const files = gatedFiles(store, {
      systemFolder: ".system",
      visible: async (p) => p === "alpha",
      authorize: async () => {},
    });
    await fc.assert(
      fc.asyncProperty(rawPath, async (p) => {
        let text = "";
        for await (const chunk of files.read(p)) text += new TextDecoder().decode(chunk);
        expect(text).not.toContain("SECRET");
        for await (const e of files.list(p, { recursive: true }))
          expect(e.path.toLowerCase()).not.toContain("/.system");
        expect((await files.exists(p)) && normalise(p).toLowerCase().includes(".system")).toBe(
          false,
        );
      }),
    );
  });
});
