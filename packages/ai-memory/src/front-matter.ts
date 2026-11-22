// Memory files are Markdown with YAML front matter (statewalker/statewalker-root#157). Each file the
// memory service writes carries a `digest` of its front matter and body, so a file changed outside
// the service fails validation at load: it is skipped and reported, never rewritten.
import { parse, stringify } from "yaml";

export interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits a Markdown file into its front matter (an object) and its body; throws on bad YAML. */
export function parseFrontMatter(text: string): FrontMatter {
  const m = FENCE.exec(text);
  if (!m) return { data: {}, body: text };
  const data = parse(m[1] ?? "", { maxAliasCount: 0 }) ?? {};
  if (typeof data !== "object" || Array.isArray(data))
    throw new Error("the front matter is not a mapping");
  return { data: data as Record<string, unknown>, body: text.slice(m[0].length) };
}

/** A Markdown file of front matter and body. */
export function formatFrontMatter(data: Record<string, unknown>, body: string): string {
  return `---\n${stringify(data).trimEnd()}\n---\n${body}`;
}

/** The front-matter key holding the digest. */
export const DIGEST = "digest";

/** JSON with object keys sorted, so equal values give equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** The digest of a file's front matter (without its digest) and body. */
export async function digestOf(data: Record<string, unknown>, body: string): Promise<string> {
  const { [DIGEST]: _, ...rest } = data;
  const bytes = new TextEncoder().encode(`${canonical(rest)}\n${body}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The file's text with a fresh digest. */
export async function sealed(data: Record<string, unknown>, body: string): Promise<string> {
  const { [DIGEST]: _, ...rest } = data;
  return formatFrontMatter({ ...rest, [DIGEST]: await digestOf(rest, body) }, body);
}

/**
 * The front matter and body of a file the service wrote, unchanged since; a reason otherwise. The
 * check runs on the parsed values, so it holds across the YAML round trip.
 */
export async function unsealed(text: string): Promise<FrontMatter | { problem: string }> {
  let fm: FrontMatter;
  try {
    fm = parseFrontMatter(text);
  } catch (e) {
    return { problem: `unreadable front matter: ${String((e as Error)?.message ?? e)}` };
  }
  if (typeof fm.data[DIGEST] !== "string") return { problem: "changed outside the memory service" };
  if ((await digestOf(fm.data, fm.body)) !== fm.data[DIGEST])
    return { problem: "changed outside the memory service" };
  return fm;
}
