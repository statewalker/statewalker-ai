// The files copied in to a remote harness at the start of its session
// (statewalker/statewalker-root#109): what the session's capability can read of its project under
// the agent's `inputs` patterns, read through the session's own gated view (so the system folder
// and ignored files are already absent), never the definitions mount, up to a size limit.
import type { FilesApi } from "@statewalker/webrun-files";

/** The definitions mount, a view of the catalog: never copied. */
const DEFINITIONS = ".agents";

/** `*` within a segment, `**` across segments; a pattern also covers what is under what it names. */
export function inputMatches(pattern: string, path: string): boolean {
  const pat = pattern.split("/").filter(Boolean);
  const segs = path.split("/").filter(Boolean);
  const seg = (p: string, s: string) =>
    new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(s);
  const walk = (i: number, j: number): boolean => {
    if (i === pat.length) return true;
    const p = pat[i] as string;
    if (p === "**") {
      for (let k = j; k <= segs.length; k++) if (walk(i + 1, k)) return true;
      return false;
    }
    return j < segs.length && seg(p, segs[j] as string) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

export interface CollectedInputs {
  /** Paths relative to the project, with their bytes. */
  files: { path: string; content: Uint8Array }[];
  /** What was left out for the size limit (relative paths). */
  skipped: string[];
}

async function bytesOf(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of files.read(path)) parts.push(p);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The project's readable files under `patterns` (default every file), within `maxBytes`. */
export async function collectInputs(
  files: FilesApi,
  project: string,
  patterns: readonly string[] | undefined,
  maxBytes: number,
): Promise<CollectedInputs> {
  const root = `/${project}`;
  const wanted = patterns?.length ? patterns : ["**"];
  const found: { path: string; size: number }[] = [];
  for await (const e of files.list(root, { recursive: true })) {
    if (e.kind !== "file") continue;
    const rel = e.path.slice(root.length + 1);
    if (!rel || rel === DEFINITIONS || rel.startsWith(`${DEFINITIONS}/`)) continue;
    if (!wanted.some((p) => inputMatches(p, rel))) continue;
    found.push({ path: rel, size: Number(e.size ?? 0) });
  }
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const out: CollectedInputs = { files: [], skipped: [] };
  let total = 0;
  for (const f of found) {
    if (total + f.size > maxBytes) {
      out.skipped.push(f.path);
      continue;
    }
    let content: Uint8Array;
    try {
      content = await bytesOf(files, `${root}/${f.path}`);
    } catch {
      // A read the gate refuses now (a mode that asks about reads) is not copied.
      continue;
    }
    if (total + content.length > maxBytes) {
      out.skipped.push(f.path);
      continue;
    }
    total += content.length;
    out.files.push({ path: f.path, content });
  }
  return out;
}

const toBase64 = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** The UHP input of a user message, with files inlined as data URLs. */
export function packInput(text: string, files: CollectedInputs["files"] = []): unknown[] {
  return [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text },
        ...files.map((f) => ({
          type: "input_file",
          filename: f.path,
          file_data: `data:application/octet-stream;base64,${toBase64(f.content)}`,
        })),
      ],
    },
  ];
}
