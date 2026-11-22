// The plugin builder (statewalker/statewalker-root#82, #130): a plugin's tool scripts bundled by
// webrun-bundler into one ESM bundle per tool, named by content hash, with an OpenAPI document for
// every tool (generated for OpenCode-style tools), and the acceptance check for workspace and
// project plugins.

import { MemFilesApi } from "@statewalker/webrun-files-mem";
import * as esbuild from "esbuild-wasm";
import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_SCHEMA,
  acceptBundle,
  BUILD_MANIFEST,
  buildPlugin,
  catalogToolDefinitions,
  hashFiles,
  type Plugin,
  TOOL_EXTENSION,
} from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const TOOLS = "dev.cellb.harness/tools";

async function pluginOf(files: Record<string, string>): Promise<Plugin> {
  const map = new Map<string, Uint8Array>(
    Object.entries({
      "plugin.json": JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA, name: "calc" }),
      ...files,
    }).map(([k, v]) => [k, enc.encode(v)]),
  );
  return { name: "calc", layout: "agent-plugins", files: map, hash: await hashFiles(map) };
}

const openapi = (...ops: string[]) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "calc", version: "1" },
    paths: Object.fromEntries(
      ops.map((op) => [
        `/${op}`,
        {
          post: {
            operationId: op,
            summary: `does ${op}`,
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { a: { type: "number" } } },
                },
              },
            },
          },
        },
      ]),
    ),
  });

const text = (p: Plugin, path: string) => dec.decode(p.files.get(path));

async function catalogOf(p: Plugin) {
  const fs = new MemFilesApi();
  for (const [path, data] of p.files) await fs.write(`/${p.name}/${path}`, [data]);
  return fs;
}

describe("the plugin builder", () => {
  it("bundles each operation's script into one ESM bundle named by its hash", async () => {
    const built = await buildPlugin(
      await pluginOf({
        [`${TOOLS}/openapi.json`]: openapi("add"),
        [`${TOOLS}/add.ts`]:
          'import { twice } from "./lib/twice";\nexport default async function execute(input: { a: number }) { return twice(input.a); }',
        [`${TOOLS}/lib/twice.ts`]: "export const twice = (x: number): number => x * 2;",
      }),
      { esbuild },
    );
    expect(built.problems).toEqual([]);
    const plugin = built.plugin as Plugin;
    const manifest = JSON.parse(text(plugin, BUILD_MANIFEST));
    expect(manifest.tools.add).toMatchObject({
      language: "js",
      bundle: "dev.cellb.harness/build/add.js",
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const code = text(plugin, manifest.tools.add.bundle);
    expect(code).toContain("x * 2");
    expect(code).not.toMatch(/^\s*import\s/m);
    // The bundle is part of the plugin's hash.
    expect(plugin.hash).toBe(await hashFiles(plugin.files));
    // The tool's route names its bundle.
    const [def] = await catalogToolDefinitions(await catalogOf(plugin));
    expect(def?.[TOOL_EXTENSION].route).toEqual({
      kind: "native",
      entry: "add",
      language: "js",
      bundle: "dev.cellb.harness/build/add.js",
      hash: manifest.tools.add.hash,
    });
  });

  it("fails the build when scripts and operations don't match", async () => {
    const missing = await buildPlugin(
      await pluginOf({
        [`${TOOLS}/openapi.json`]: openapi("add", "sub"),
        [`${TOOLS}/add.js`]: "export default async () => 1;",
      }),
      { esbuild },
    );
    expect(missing.plugin).toBeUndefined();
    expect(missing.problems.join("\n")).toMatch(/operation 'sub' has no script/);
    const extra = await buildPlugin(
      await pluginOf({
        [`${TOOLS}/openapi.json`]: openapi("add"),
        [`${TOOLS}/add.js`]: "export default async () => 1;",
        [`${TOOLS}/mul.js`]: "export default async () => 1;",
      }),
      { esbuild },
    );
    expect(extra.plugin).toBeUndefined();
    expect(extra.problems.join("\n")).toMatch(/script 'mul.js' has no operation/);
  });

  it("records Python scripts, unbundled", async () => {
    const built = await buildPlugin(
      await pluginOf({
        [`${TOOLS}/openapi.json`]: openapi("add"),
        [`${TOOLS}/add.py`]: "def execute(input, ctx):\n    return 1\n",
      }),
      { esbuild },
    );
    expect(built.problems).toEqual([]);
    const manifest = JSON.parse(text(built.plugin as Plugin, BUILD_MANIFEST));
    expect(manifest.tools.add).toEqual({
      language: "python",
      source: "dev.cellb.harness/tools/add.py",
    });
  });

  it("generates the OpenAPI document of OpenCode-style tools from what they describe", async () => {
    const described: string[] = [];
    const built = await buildPlugin(
      await pluginOf({
        [`${TOOLS}/shout.ts`]:
          'export default { description: "Shouts", args: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, async execute(a: { text: string }) { return a.text.toUpperCase(); } };',
      }),
      {
        esbuild,
        describe: async (code) => {
          described.push(code);
          return {
            description: "Shouts",
            args: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          };
        },
      },
    );
    expect(built.problems).toEqual([]);
    expect(described[0]).toContain("toUpperCase");
    const plugin = built.plugin as Plugin;
    const doc = JSON.parse(text(plugin, `${TOOLS}/openapi.json`));
    expect(doc.paths["/shout"].post).toMatchObject({ operationId: "shout", summary: "Shouts" });
    const [def] = await catalogToolDefinitions(await catalogOf(plugin));
    expect(def?.[TOOL_EXTENSION]).toMatchObject({ id: "calc/shout", source: "native" });
    expect(def?.info.description).toBe("Shouts");
  });

  it("holds workspace and project bundles to the acceptance check", async () => {
    const built = await buildPlugin(
      await pluginOf({
        [`${TOOLS}/openapi.json`]: openapi("add"),
        [`${TOOLS}/add.js`]: "export default async () => process.env.SECRET;",
      }),
      { esbuild, accept: true },
    );
    expect(built.plugin).toBeUndefined();
    expect(built.problems.join("\n")).toMatch(/add: .*'process'/);
  });
});

describe("the acceptance check", () => {
  it("accepts self-contained code using the language's own globals", () => {
    expect(
      acceptBundle(
        "const m = new Map(); export default async function (i, ctx) { await ctx.files.stats('/'); return JSON.stringify([...m, Math.max(1, 2), new TextEncoder().encode('x')]); }",
      ),
    ).toEqual([]);
  });

  it.each([
    ["the host's globals", "export default () => process.exit(1);", /'process'/],
    ["the global object", "export default () => globalThis.fetch;", /'globalThis'/],
    ["the network", "export default () => fetch('https://x');", /'fetch'/],
    ["eval", "export default () => eval('1');", /'eval'/],
    ["the Function constructor", "export default () => Function('return this')();", /'Function'/],
    ["dynamic import", "export default () => import('node:fs');", /import/],
    ["static import", "import fs from 'node:fs'; export default () => fs;", /import/],
    ["import.meta", "export default () => import.meta.url;", /import\.meta/],
    ["require", "export default () => require('fs');", /'require'/],
    ["unparseable code", "export default () => {", /parse/],
  ])("refuses %s", (_what, code, problem) => {
    expect(acceptBundle(code).join("\n")).toMatch(problem);
  });
});
