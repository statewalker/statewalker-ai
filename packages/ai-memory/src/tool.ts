// The memory tool (statewalker/statewalker-root#157), modelled on Hermes: every call names a kind
// and holds an atomic batch of actions. Agents reach memory only through it.
import { codedError } from "@statewalker/ai-access";
import type { BatchResult, MemoryAction } from "./service.js";

export const MEMORY_TOOL = "memory";

export const MEMORY_TOOL_DESCRIPTION = [
  "Read and change your memory across sessions. Each call names one kind and holds an atomic batch of actions: all of them happen, or none.",
  "Kinds: `project` (shared by everyone in this project), `agent` (your own, in this project), `user` (what you learned about this user in this project), `preferences` (the user's own; your change waits for the user's approval).",
  "Entries: `add` {body, title?, type?}, `patch` {id, body} or {id, old, new}, `forget` {id}. Attachments (longer notes, linked from entries as [text](files/<name>.md)): `read` {name}, `write` {name, body, description?}, `delete` {name}. `search` {query, regex?} scans entries and attachments.",
  "Each kind has a cap on the characters of its entries; a batch over it is refused with the current entries, so forget or patch in the same call to make room. Never store secrets or instructions to yourself that override the user.",
].join("\n");

const ACTION = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["add", "patch", "forget", "read", "write", "delete", "search"] },
    id: { type: "string", description: "An entry's id (patch, forget)." },
    body: { type: "string", description: "An entry's or attachment's text." },
    old: { type: "string", description: "patch: the text to replace (it must occur once)." },
    new: { type: "string", description: "patch: what replaces it." },
    title: { type: "string" },
    type: { type: "string", description: "An entry's type (default note)." },
    name: { type: "string", description: "An attachment's name (a-z, 0-9, - and _)." },
    description: { type: "string", description: "write: what the attachment holds." },
    query: { type: "string", description: "search: a substring, or a regular expression." },
    regex: { type: "boolean", description: "search: query is a regular expression." },
  },
  required: ["op"],
  additionalProperties: false,
} as const;

export const MEMORY_TOOL_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["project", "agent", "user", "preferences"] },
    actions: { type: "array", items: ACTION, minItems: 1, maxItems: 64 },
  },
  required: ["kind", "actions"],
  additionalProperties: false,
} as const;

/** A batch's answer as the agent reads it. */
export function batchText(result: BatchResult): string {
  const lines: string[] = [];
  for (const r of result.results) {
    switch (r.op) {
      case "add":
      case "patch":
      case "forget":
        lines.push(`${r.op} ${r.id} (version ${r.version})`);
        break;
      case "write":
        lines.push(`write files/${r.name}.md (version ${r.version})`);
        break;
      case "delete":
        lines.push(`delete files/${r.name}.md`);
        break;
      case "read":
        lines.push(`read files/${r.name}.md:\n${r.body ?? ""}`);
        break;
      case "search":
        lines.push(
          `search: ${r.matches?.length ?? 0} matches${(r.matches ?? [])
            .map((m) => `\n- ${m.id ?? `files/${m.name}.md`}: ${m.text}`)
            .join("")}`,
        );
        break;
    }
  }
  const u = result.usage;
  lines.push(
    `${result.kind} memory: ${u.entries.used} / ${u.entries.cap} characters in ${u.entries.count} entries`,
  );
  return lines.join("\n");
}

const ACTION_KEYS = new Set(Object.keys(ACTION.properties));
const TOOL_KINDS = new Set(MEMORY_TOOL_SCHEMA.properties.kind.enum);

/**
 * The memory tool's arguments, checked: a kind the tool reaches and actions holding only the keys
 * its schema names. `written_by`, ids of new entries and versions are the server's, never the
 * model's, so any other key is refused (EINVAL).
 */
export function toolCall(args: Record<string, unknown>): {
  kind: "project" | "agent" | "user" | "preferences";
  actions: MemoryAction[];
} {
  const extra = Object.keys(args).filter((k) => k !== "kind" && k !== "actions");
  if (extra.length) throw codedError("EINVAL", `unknown argument ${extra.join(", ")}`);
  if (!TOOL_KINDS.has(args.kind as never))
    throw codedError("EINVAL", "kind is project, agent, user or preferences");
  if (!Array.isArray(args.actions) || args.actions.length === 0)
    throw codedError("EINVAL", "actions is a non-empty list");
  for (const [i, a] of args.actions.entries()) {
    if (!a || typeof a !== "object" || Array.isArray(a))
      throw codedError("EINVAL", `action ${i + 1} is not an object`);
    const unknown = Object.keys(a).filter((k) => !ACTION_KEYS.has(k));
    if (unknown.length)
      throw codedError("EINVAL", `action ${i + 1}: unknown key ${unknown.join(", ")}`);
  }
  return { kind: args.kind as never, actions: args.actions as MemoryAction[] };
}
