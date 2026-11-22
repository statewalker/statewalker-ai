// The four kinds of memory (statewalker/statewalker-root#157), their caps, and the people and
// agents behind a write.

export type MemoryKind = "preferences" | "user" | "project" | "agent";

export const MEMORY_KINDS: readonly MemoryKind[] = ["preferences", "user", "project", "agent"];

export const isMemoryKind = (k: unknown): k is MemoryKind =>
  typeof k === "string" && (MEMORY_KINDS as readonly string[]).includes(k);

/** Who wrote something, stamped by the server: never supplied by the caller. */
export interface Writer {
  user: string;
  agent?: string;
  session?: string;
  run?: string;
}

/** The fixed id an erased user's `written_by` becomes in shared memory. */
export const DELETED_USER = "deleted-user";

/**
 * Caps on what each kind holds: the characters of its active entries' bodies, each attachment's
 * bytes, and all attachments' bytes. Configurable per deployment and per project.
 */
export interface MemoryCaps {
  entries?: Partial<Record<MemoryKind, number>>;
  /** Bytes of one attachment. */
  file?: number;
  /** Bytes of all attachments of one kind. */
  files?: number;
}

export const DEFAULT_CAPS = {
  entries: { preferences: 1375, user: 1375, project: 2200, agent: 2200 },
  file: 8192,
  files: 65536,
} as const;

const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

/**
 * Caps from JSON text or a value (`{entries: {<kind>: n}, file: n, files: n}`), leniently: what is
 * not a positive integer is left out, and later layers (a project's) override earlier ones (the
 * deployment's).
 */
export function parseMemoryCaps(...layers: unknown[]): MemoryCaps {
  const out: { entries: Partial<Record<MemoryKind, number>>; file?: number; files?: number } = {
    entries: {},
  };
  for (let layer of layers) {
    if (typeof layer === "string") {
      if (!layer.trim()) continue;
      try {
        layer = JSON.parse(layer);
      } catch {
        continue;
      }
    }
    if (!layer || typeof layer !== "object") continue;
    const l = layer as Record<string, unknown>;
    const entries = (l.entries ?? {}) as Record<string, unknown>;
    if (entries && typeof entries === "object")
      for (const k of MEMORY_KINDS) {
        const n = positive(entries[k]);
        if (n) out.entries[k] = n;
      }
    const file = positive(l.file);
    if (file) out.file = file;
    const files = positive(l.files);
    if (files) out.files = files;
  }
  return out;
}

/** The caps a service holds a kind to. */
export function capsOf(caps: MemoryCaps | undefined, kind: MemoryKind) {
  return {
    entries: caps?.entries?.[kind] ?? DEFAULT_CAPS.entries[kind],
    file: caps?.file ?? DEFAULT_CAPS.file,
    files: caps?.files ?? DEFAULT_CAPS.files,
  };
}
