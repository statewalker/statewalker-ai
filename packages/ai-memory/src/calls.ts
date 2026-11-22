// One call of the memory service, as the memory tool and the memory API send it to the Durable
// Object that holds the kind: the Workspace DO for project and agent memory, the User DO for user
// memory and preferences. Every call is checked here before it crosses a boundary.
import { codedError } from "@statewalker/ai-access";
import { isMemoryKind, type MemoryKind } from "./kinds.js";
import type { MemoryAction } from "./service.js";

/** `prime` is an agent session's own: every kind whole, at its start and after a compaction. */
export type MemoryOp = "list" | "entry" | "file" | "batch" | "erase" | "agents" | "prime";

export const MEMORY_OPS: readonly MemoryOp[] = [
  "list",
  "entry",
  "file",
  "batch",
  "erase",
  "agents",
  "prime",
];

export interface MemoryCall {
  op: MemoryOp;
  /** `preferences`, `user`, `project`, `agent` (the session's own) or `agent:<plugin>/<agent>`. */
  kind?: string;
  /** The project (the memory API's; an agent session's is its own). */
  project?: string;
  id?: string;
  name?: string;
  actions?: MemoryAction[];
}

/** The actions that change memory; the rest (`read`, `search`) only read it. */
export const WRITE_OPS = new Set(["add", "patch", "forget", "write", "delete"]);

/** Whether a call changes memory. */
export const writes = (call: MemoryCall): boolean =>
  call.op === "erase" ||
  (call.op === "batch" && (call.actions ?? []).some((a) => WRITE_OPS.has(String(a?.op))));

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A kind as a call names it: the kind, and the agent for `agent:<plugin>/<agent>`. */
export function memoryRef(kind: unknown): { kind: MemoryKind; agent?: string } {
  if (typeof kind === "string" && kind.startsWith("agent:")) {
    const agent = kind.slice("agent:".length);
    const [plugin, name, ...rest] = agent.split("/");
    if (!plugin || !name || rest.length || !SEGMENT.test(plugin) || !SEGMENT.test(name))
      throw codedError("ENOENT", "no such memory");
    return { kind: "agent", agent };
  }
  if (!isMemoryKind(kind)) throw codedError("ENOENT", "no such memory");
  return { kind };
}

/** A project's name in a call: one path segment. */
export function projectName(project: unknown): string {
  if (typeof project !== "string" || !PROJECT.test(project))
    throw codedError("ENOENT", "no such project");
  return project;
}

/** A call as it arrives over RPC or REST: checked (EINVAL otherwise). */
export function memoryCall(value: unknown): MemoryCall {
  const c = (value ?? {}) as Record<string, unknown>;
  if (!MEMORY_OPS.includes(c.op as MemoryOp))
    throw codedError("EINVAL", `op is one of ${MEMORY_OPS.join(", ")}`);
  if (c.kind !== undefined && typeof c.kind !== "string")
    throw codedError("EINVAL", "kind must be text");
  if (c.project !== undefined && typeof c.project !== "string")
    throw codedError("EINVAL", "project must be text");
  if (c.id !== undefined && typeof c.id !== "string") throw codedError("EINVAL", "id must be text");
  if (c.name !== undefined && typeof c.name !== "string")
    throw codedError("EINVAL", "name must be text");
  if (c.op === "batch" && (!Array.isArray(c.actions) || c.actions.length === 0))
    throw codedError("EINVAL", "a batch is a non-empty list of actions");
  if (c.op === "batch")
    for (const a of c.actions as unknown[])
      if (!a || typeof a !== "object" || Array.isArray(a))
        throw codedError("EINVAL", "each action is an object with an op");
  return {
    op: c.op as MemoryOp,
    ...(c.kind !== undefined ? { kind: c.kind as string } : {}),
    ...(c.project !== undefined ? { project: c.project as string } : {}),
    ...(c.id !== undefined ? { id: c.id as string } : {}),
    ...(c.name !== undefined ? { name: c.name as string } : {}),
    ...(c.op === "batch" ? { actions: c.actions as MemoryAction[] } : {}),
  };
}
