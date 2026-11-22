// A Worker project's wrangler configuration, read from its folder.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** JSONC → JSON: line and block comments outside strings, and trailing commas. */
export function stripJsonc(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      const start = i;
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === "\\") i++;
      out += source.slice(start, i + 1);
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The project's wrangler.jsonc as an object, without its `$schema`; `main` stays relative. */
export function projectConfig(
  dir: string,
): { main: string; vars?: Record<string, string> } & Record<string, unknown> {
  const config = JSON.parse(stripJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")));
  delete config.$schema;
  return config;
}
