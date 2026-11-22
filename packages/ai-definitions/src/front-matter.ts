// Markdown files with YAML front matter: agents (`agents/<name>.md`) and skills (`SKILL.md`).
import { parse, stringify } from "yaml";

export interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits a Markdown file into its front matter (an object) and its body; EINVAL-like errors throw. */
export function parseFrontMatter(text: string): FrontMatter {
  const m = FENCE.exec(text.replace(/^﻿/, ""));
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
