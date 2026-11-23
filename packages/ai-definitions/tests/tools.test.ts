// Tool definitions (statewalker/statewalker-root#90, built by #129): every tool is one OpenAPI 3.1
// document in the harness's restricted profile (one `POST /tools/<plugin>/<tool>`, a closed object
// input, a 200 output, the `x-dev.cellb.harness` extension), converted from a plugin's
// `tools/openapi` file or from an imported REST spec (`tools/rest/`), and projected to MCP.
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_SCHEMA,
  catalogToolDefinitions,
  restRequest,
  TOOL_EXTENSION,
  type ToolDefinition,
  toMcpTool,
  toolInput,
  toolName,
} from "../src/index.js";

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

async function catalogOf(files: Record<string, string>) {
  const catalog = new MemFilesApi();
  for (const [path, text] of Object.entries(files)) await writeText(catalog, path, text);
  return catalog;
}

const plugin = (name: string) => ({
  [`/${name}/plugin.json`]: JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA, name }),
});

/** Every object schema in a schema closed, recursively. */
function objectsIn(schema: unknown, out: Record<string, unknown>[] = []) {
  if (Array.isArray(schema)) for (const s of schema) objectsIn(s, out);
  else if (schema && typeof schema === "object") {
    const o = schema as Record<string, unknown>;
    if (o.type === "object") out.push(o);
    for (const v of Object.values(o)) objectsIn(v, out);
  }
  return out;
}

const byId = (defs: ToolDefinition[], id: string) => {
  const found = defs.find((d) => d[TOOL_EXTENSION].id === id);
  if (!found) throw new Error(`no tool ${id} among ${defs.map((d) => d[TOOL_EXTENSION].id)}`);
  return found;
};

describe("tool names", () => {
  it("are <plugin>__<tool> in letters, digits, _ and -, at most 64 characters", () => {
    expect(toolName("notes", "word_count")).toBe("notes__word_count");
    expect(toolName("acme.tools", "list")).toBe("acme_tools__list");
    const long = toolName("p".repeat(60), "a".repeat(48));
    const other = toolName("p".repeat(60), `${"a".repeat(47)}b`);
    expect(long).toMatch(NAME);
    expect(long).toHaveLength(64);
    expect(other).toMatch(NAME);
    expect(other).not.toBe(long);
    expect(toolName("p".repeat(60), "a".repeat(48))).toBe(long);
  });
});

describe("a plugin's tools/openapi file", () => {
  const files = {
    ...plugin("notes"),
    "/notes/dev.cellb.harness/tools/openapi.json": JSON.stringify({
      openapi: "3.1.0",
      info: { title: "notes", version: "1" },
      paths: {
        "/word-count": {
          post: {
            operationId: "word_count",
            summary: "Counts words",
            "x-dev.cellb.harness": { action: "read" },
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      options: { type: "object", properties: { lines: { type: "boolean" } } },
                    },
                    required: ["text"],
                  },
                },
              },
            },
            responses: {
              200: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { words: { type: "integer" } } },
                  },
                },
              },
            },
          },
        },
        "/purge": { delete: { operationId: "purge", summary: "Deletes every note" } },
        "/bad": { post: { operationId: "Not-Valid" } },
      },
    }),
  };

  it("becomes one restricted-profile document per operation, with a closed input", async () => {
    const defs = await catalogToolDefinitions(await catalogOf(files));
    expect(defs.map((d) => d[TOOL_EXTENSION].id)).toEqual(["notes/purge", "notes/word_count"]);
    const wc = byId(defs, "notes/word_count");
    expect(wc.openapi).toBe("3.1.0");
    expect(Object.keys(wc.paths)).toEqual(["/tools/notes/word_count"]);
    expect(Object.keys(wc.paths["/tools/notes/word_count"] ?? {})).toEqual(["post"]);
    expect(wc[TOOL_EXTENSION]).toEqual({
      id: "notes/word_count",
      name: "notes__word_count",
      source: "native",
      plugin: "notes",
      tool: "word_count",
      action: "read",
      permission: "tools.use:notes/word_count",
      route: { kind: "native", entry: "word_count" },
    });
    const input = toolInput(wc);
    expect(input).toMatchObject({ type: "object", required: ["text"] });
    for (const o of objectsIn(input)) expect(o.additionalProperties).toBe(false);
    // Without the extension, the method says what the tool does.
    expect(byId(defs, "notes/purge")[TOOL_EXTENSION].action).toBe("write");
  });

  it("projects to an MCP tool entry with the same name, input and action hints", async () => {
    const wc = byId(await catalogToolDefinitions(await catalogOf(files)), "notes/word_count");
    expect(toMcpTool(wc)).toEqual({
      name: "notes__word_count",
      title: "notes/word_count",
      description: "Counts words",
      inputSchema: toolInput(wc),
      outputSchema: { type: "object", properties: { words: { type: "integer" } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    });
  });
});

describe("an imported REST spec", () => {
  const spec = {
    openapi: "3.0.3",
    info: { title: "Weather", version: "2" },
    servers: [{ url: "https://api.weather.test/v2" }],
    components: {
      securitySchemes: {
        key: {
          type: "apiKey",
          in: "header",
          name: "X-Api-Key",
          "x-dev.cellb.harness": { secret: "WEATHER_KEY" },
        },
      },
      schemas: { Point: { type: "object", properties: { lat: { type: "number" } } } },
    },
    security: [{ key: [] }],
    paths: {
      "/cities/{city}/forecast": {
        get: {
          operationId: "getForecast",
          summary: "The forecast for a city",
          parameters: [
            { name: "city", in: "path", required: true, schema: { type: "string" } },
            { name: "days", in: "query", schema: { type: "integer" } },
            { name: "X-Units", in: "header", schema: { type: "string" } },
            { name: "session", in: "cookie", schema: { type: "string" } },
          ],
          responses: { 200: { description: "ok" }, 404: { description: "no such city" } },
        },
      },
      "/points": {
        post: {
          operationId: "addPoints",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Point" } },
              },
            },
          },
          responses: { 201: { description: "added" } },
        },
      },
      "/stations": {
        post: {
          operationId: "addStation",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              },
            },
          },
        },
      },
      "/upload": {
        post: {
          operationId: "upload",
          requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } },
        },
      },
    },
  };
  const files = {
    ...plugin("weather"),
    "/weather/dev.cellb.harness/tools/rest/weather.json": JSON.stringify(spec),
  };

  it("flattens parameters into one closed object, hides the auth scheme and keeps the route", async () => {
    const defs = await catalogToolDefinitions(await catalogOf(files));
    // Multipart operations are not imported; operationIds become snake_case.
    expect(defs.map((d) => d[TOOL_EXTENSION].id)).toEqual([
      "weather/add_points",
      "weather/add_station",
      "weather/get_forecast",
    ]);
    const forecast = byId(defs, "weather/get_forecast");
    expect(forecast[TOOL_EXTENSION]).toMatchObject({
      name: "weather__get_forecast",
      source: "rest",
      action: "read",
      route: {
        kind: "rest",
        method: "GET",
        url: "https://api.weather.test/v2/cities/{city}/forecast",
        params: [
          { name: "city", in: "path" },
          { name: "days", in: "query" },
          { name: "X-Units", in: "header" },
        ],
        auth: { in: "header", name: "X-Api-Key", secret: "WEATHER_KEY" },
      },
    });
    const input = toolInput(forecast);
    expect(Object.keys(input.properties as object).sort()).toEqual(["X-Units", "city", "days"]);
    expect(input.required).toEqual(["city"]);
    expect(input.additionalProperties).toBe(false);
    expect(JSON.stringify(input)).not.toMatch(/X-Api-Key|WEATHER_KEY|session/);
    // A write by its method.
    expect(byId(defs, "weather/add_station")[TOOL_EXTENSION].action).toBe("write");
  });

  it("wraps a non-object body as the body property, its references inlined", async () => {
    const defs = await catalogToolDefinitions(await catalogOf(files));
    const add = byId(defs, "weather/add_points");
    expect(add[TOOL_EXTENSION].route).toMatchObject({ kind: "rest", body: "wrapped" });
    expect(toolInput(add)).toEqual({
      type: "object",
      properties: {
        body: {
          type: "array",
          items: {
            type: "object",
            properties: { lat: { type: "number" } },
            additionalProperties: false,
          },
        },
      },
      required: ["body"],
      additionalProperties: false,
    });
  });

  it("rebuilds a call from its route: path, query, header, body and the key's placeholder", async () => {
    const defs = await catalogToolDefinitions(await catalogOf(files));
    expect(
      restRequest(byId(defs, "weather/get_forecast"), {
        city: "São Paulo/x",
        days: 3,
        "X-Units": "metric",
      }),
    ).toEqual({
      method: "GET",
      url: "https://api.weather.test/v2/cities/S%C3%A3o%20Paulo%2Fx/forecast?days=3",
      headers: { "X-Units": "metric", "X-Api-Key": "{{secret:WEATHER_KEY}}" },
    });
    expect(restRequest(byId(defs, "weather/add_station"), { name: "north" })).toEqual({
      method: "POST",
      url: "https://api.weather.test/v2/stations",
      headers: { "content-type": "application/json", "X-Api-Key": "{{secret:WEATHER_KEY}}" },
      body: JSON.stringify({ name: "north" }),
    });
    expect(restRequest(byId(defs, "weather/add_points"), { body: [{ lat: 1 }] }).body).toBe(
      JSON.stringify([{ lat: 1 }]),
    );
  });

  it("never lets the model's input name a secret or a header of the route's own", async () => {
    const defs = await catalogToolDefinitions(await catalogOf(files));
    const forecast = byId(defs, "weather/get_forecast");
    expect(() => restRequest(forecast, { city: "x", "X-Units": "{{secret:WEATHER_KEY}}" })).toThrow(
      /EINVAL/,
    );
    // In the path or the query, a placeholder is encoded, so it never resolves.
    expect(restRequest(forecast, { city: "{{secret:WEATHER_KEY}}" }).url).toContain(
      "%7B%7Bsecret%3AWEATHER_KEY%7D%7D",
    );
    expect(() => restRequest(forecast, {})).toThrow(/EINVAL.*city/);
  });

  it("refuses a path argument that would leave the route's path (., .., empty)", async () => {
    const defs = await catalogToolDefinitions(await catalogOf(files));
    const forecast = byId(defs, "weather/get_forecast");
    for (const city of ["..", ".", ""])
      expect(() => restRequest(forecast, { city })).toThrow(/EINVAL/);
    // Dots inside a value stay one segment.
    expect(restRequest(forecast, { city: "a..b" }).url).toBe(
      "https://api.weather.test/v2/cities/a..b/forecast",
    );
  });

  it("names a key's secret after the plugin when the scheme does not", async () => {
    const plain = structuredClone(spec);
    // biome-ignore lint/suspicious/noExplicitAny: a fixture edit
    delete (plain.components.securitySchemes.key as any)["x-dev.cellb.harness"];
    const defs = await catalogToolDefinitions(
      await catalogOf({
        ...plugin("acme.weather"),
        "/acme.weather/dev.cellb.harness/tools/rest/api.json": JSON.stringify(plain),
      }),
    );
    expect(byId(defs, "acme.weather/get_forecast")[TOOL_EXTENSION].route).toMatchObject({
      auth: { secret: "ACME_WEATHER_API_KEY" },
    });
  });
});

describe("a native tool's network declaration (statewalker/statewalker-root#208)", () => {
  it("carries the operation's requires.network into its route, a request and never shown to a model", async () => {
    const { nativeTools } = await import("../src/index.js");
    const [tool] = nativeTools("geo", {
      openapi: "3.1.0",
      info: { title: "geo", version: "1" },
      paths: {
        "/lookup": {
          post: {
            operationId: "lookup",
            summary: "Looks a place up",
            "x-dev.cellb.harness": {
              action: "read",
              requires: { network: [{ host: "api.geo.example", path: "/v1" }] },
            },
            requestBody: {
              content: { "application/json": { schema: { type: "object", properties: {} } } },
            },
          },
        },
      },
    });
    expect(tool?.[TOOL_EXTENSION].route).toMatchObject({
      kind: "native",
      requires: { network: [{ host: "api.geo.example", path: "/v1" }] },
    });
    expect(JSON.stringify(toMcpTool(tool as ToolDefinition))).not.toContain("api.geo.example");
  });
});
