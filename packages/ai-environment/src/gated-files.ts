// The gated file view (statewalker/statewalker-root#80, #122): what one holder (an agent session, or
// the user's own session) sees of its workspace. Every path is normalised, then:
// - only the projects the holder is a member of are there: any other first-level folder is absent;
// - a project's system folder (and the workspace's own, at the top) is absent, under every path form
//   and for every operation, whatever the role or mode;
// - files the ignore rules name are absent too, for the holders given ignore rules (agent sessions
//   and tool calls, never the user's own session);
// - every entry an operation touches is authorized, and every block of a stream again, so a
//   revocation stops a transfer at the next block.
// "Absent" means exactly what a path that does not exist gets: `stats` undefined, `exists` false, a
// read of nothing, an empty listing, `remove` false; creating something there is ENOENT.
import { codedError, type FileAction } from "@statewalker/ai-access";
import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { normalise, parentOf } from "./paths.js";

export type { FileAction };

export interface GatedFilesOptions {
  /** The system folder's name (default `.system`). */
  systemFolder: string;
  /** Whether the holder sees a project (a first-level folder) at all: membership, read now. */
  visible(project: string): Promise<boolean>;
  /** Throws (EACCES) unless the holder may take this action on this normalised path now. */
  authorize(action: FileAction, path: string): Promise<void>;
  /** A project's ignore rules for this holder; none (the user's own session) hides nothing. */
  ignoreRules?(project: string): Promise<IgnoreMatcher | undefined>;
  /** Bytes per block of a read; every block is authorized again (default 1 MiB). */
  blockSize?: number;
}

/** Whether a path relative to a project (its segments) is ignored. */
export interface IgnoreMatcher {
  ignores(segments: readonly string[]): boolean;
}

export const DEFAULT_BLOCK_SIZE = 1024 * 1024;

/** A segment compared as backends that fold case or Unicode forms would see it. */
const folded = (segment: string) => segment.normalize("NFC").toLowerCase();

/**
 * Whether a normalised path is a system folder or under one: a project's (the second segment) or
 * the workspace's own (the first). Compared without case and Unicode form, so a backend that folds
 * them (a case-insensitive local FS) gives no way in.
 */
export function inSystemFolder(path: string, systemFolder: string): boolean {
  const name = folded(systemFolder);
  const [, first, second] = path.split("/");
  return (
    (first !== undefined && folded(first) === name) ||
    (second !== undefined && folded(second) === name)
  );
}

const enoent = (path: string) => codedError("ENOENT", `no such file or directory, '${path}'`);

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

/** The blocks of a stream, none larger than `size`. */
async function* blocks(source: AsyncIterable<Uint8Array>, size: number) {
  for await (const chunk of source)
    for (let at = 0; at < chunk.length; at += size) yield chunk.subarray(at, at + size);
}

const isUnder = (path: string, dir: string) =>
  dir === "/" ? path !== "/" : path.startsWith(`${dir}/`);

/** The checks of each block of a stream already open, decided now. */
export interface StreamChecks {
  /** Whether a normalised path is hidden from the holder now. */
  hidden(path: string): Promise<boolean>;
  /**
   * Throws unless the holder may still take the action on the path. A stream opened on a hidden
   * path passes (it gives nothing, as a missing file would); one whose path became hidden since
   * (a removal from the project, a new ignore rule) is ENOENT.
   */
  allowed(action: FileAction, path: string, hiddenAtOpen: boolean): Promise<void>;
}

export function streamChecks(options: GatedFilesOptions): StreamChecks {
  const hidden = (path: string) => scopeOf(options).hidden(path);
  return {
    hidden,
    async allowed(action, path, hiddenAtOpen) {
      if (hiddenAtOpen) return;
      if (await hidden(path)) throw enoent(path);
      await options.authorize(action, path);
    },
  };
}

/** The value kept under a key, made once. */
function memo<T>(map: Map<string, T>, key: string, make: () => T): T {
  if (!map.has(key)) map.set(key, make());
  return map.get(key) as T;
}

/** What one operation knows: membership and ignore rules, read once per operation. */
function scopeOf(options: GatedFilesOptions) {
  const visible = new Map<string, Promise<boolean>>();
  const rules = new Map<string, Promise<IgnoreMatcher | undefined>>();
  return {
    async hidden(path: string): Promise<boolean> {
      if (path === "/") return false;
      if (inSystemFolder(path, options.systemFolder)) return true;
      const segments = path.split("/").slice(1);
      const project = segments[0] as string;
      if (!(await memo(visible, project, () => options.visible(project)))) return true;
      const { ignoreRules } = options;
      if (!ignoreRules || segments.length < 2) return false;
      const rules_ = await memo(rules, project, () => ignoreRules(project));
      return rules_?.ignores(segments.slice(1)) ?? false;
    },
  };
}

export function gatedFiles(store: FilesApi, options: GatedFilesOptions): FilesApi {
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const { authorize } = options;
  const scope = () => scopeOf(options);

  return {
    async *read(raw: string, readOptions?: ReadOptions): AsyncIterable<Uint8Array> {
      const path = normalise(raw);
      if (await scope().hidden(path)) return;
      await authorize("read", path);
      let first = true;
      for await (const block of blocks(store.read(path, readOptions), blockSize)) {
        // A revocation stops the transfer here, at the next block.
        if (!first) await authorize("read", path);
        first = false;
        yield block;
      }
    },

    async *list(raw: string, listOptions?: ListOptions): AsyncIterable<FileInfo> {
      const path = normalise(raw);
      const s = scope();
      if (path !== "/") {
        if (await s.hidden(path)) return;
        await authorize("list", path);
      }
      // At the top, each project is listed only when the holder may list it.
      const listable = new Map<string, Promise<boolean>>();
      for await (const entry of store.list(path, listOptions)) {
        if (await s.hidden(entry.path)) continue;
        if (path === "/") {
          const project = `/${entry.path.split("/")[1]}`;
          const ok = memo(listable, project, () =>
            authorize("list", project).then(
              () => true,
              () => false,
            ),
          );
          if (!(await ok)) continue;
        }
        yield entry;
      }
    },

    async stats(raw: string): Promise<FileStats | undefined> {
      const path = normalise(raw);
      if (path === "/") return { kind: "directory" };
      if (await scope().hidden(path)) return undefined;
      await authorize("read", path);
      return store.stats(path);
    },

    async exists(raw: string): Promise<boolean> {
      return (await this.stats(raw)) !== undefined;
    },

    async write(raw, content): Promise<void> {
      const path = normalise(raw);
      if (await scope().hidden(path)) throw enoent(raw);
      await authorize("write", path);
      async function* checked() {
        let first = true;
        for await (const block of content) {
          if (!first) await authorize("write", path);
          first = false;
          yield block;
        }
      }
      await store.write(path, checked());
    },

    async mkdir(raw: string): Promise<void> {
      const path = normalise(raw);
      if (await scope().hidden(path)) throw enoent(raw);
      await authorize("write", path);
      await store.mkdir(path);
    },

    async remove(raw: string): Promise<boolean> {
      const path = normalise(raw);
      const s = scope();
      if (await s.hidden(path)) return false;
      await authorize("delete", path);
      const plan = await planOf(path, s);
      if (!plan) return false;
      for (const e of plan.visible) await authorize("delete", e.path);
      await removeVisible(path, plan);
      return true;
    },

    copy: (source: string, target: string) => transfer(source, target, false),
    move: (source: string, target: string) => transfer(source, target, true),
  };

  interface Plan {
    stats: FileStats;
    /** Entries under the path the holder sees. */
    visible: FileInfo[];
    /** Directories that must stay because something hidden is under them (the path among them). */
    keep: Set<string>;
  }

  /** What is under a path: the entries the holder sees, and what must stay for hidden ones. */
  async function planOf(path: string, s: ReturnType<typeof scope>): Promise<Plan | undefined> {
    const stats = await store.stats(path);
    if (!stats) return undefined;
    const visible: FileInfo[] = [];
    const keep = new Set<string>();
    if (stats.kind === "directory")
      for (const entry of await collect(store.list(path, { recursive: true }))) {
        if (!(await s.hidden(entry.path))) {
          visible.push(entry);
          continue;
        }
        for (let dir = parentOf(entry.path); ; dir = parentOf(dir)) {
          keep.add(dir);
          if (dir === path || dir === "/") break;
        }
      }
    return { stats, visible, keep };
  }

  /** Removes what the holder sees under a path (the path too, when nothing hidden is under it). */
  async function removeVisible(path: string, plan: Plan): Promise<void> {
    if (plan.keep.size === 0) {
      await store.remove(path);
      return;
    }
    const removed: string[] = [];
    const sorted = [...plan.visible].sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const e of sorted) {
      if (removed.some((dir) => isUnder(e.path, dir))) continue;
      if (e.kind === "directory" && plan.keep.has(e.path)) continue;
      await store.remove(e.path);
      removed.push(e.path);
    }
  }

  async function transfer(source: string, target: string, move: boolean): Promise<boolean> {
    const from = normalise(source);
    const to = normalise(target);
    const s = scope();
    if (await s.hidden(from)) return false;
    if (await s.hidden(to)) throw enoent(target);
    if (to === from || isUnder(to, from))
      throw codedError("EINVAL", `cannot ${move ? "move" : "copy"} '${source}' into itself`);
    // Replacing a folder above the source would remove the source with it.
    if (isUnder(from, to))
      throw codedError("EINVAL", `cannot ${move ? "move" : "copy"} '${source}' onto '${target}'`);
    await authorize("read", from);
    if (move) await authorize("delete", from);
    await authorize("write", to);
    const plan = await planOf(from, s);
    if (!plan) return false;
    const targetOf = (path: string) => `${to}${path.slice(from.length)}`;
    for (const e of plan.visible) {
      const t = targetOf(e.path);
      // Nothing may land in a hidden place, such as a folder that becomes a system folder there.
      if (await s.hidden(t)) throw enoent(t);
      await authorize("read", e.path);
      if (move) await authorize("delete", e.path);
      await authorize("write", t);
    }
    // The target is replaced: what the holder sees of it goes, anything hidden in it stays.
    const old = await planOf(to, s);
    if (old) {
      await authorize("delete", to);
      for (const e of old.visible) await authorize("delete", e.path);
      await removeVisible(to, old);
    }
    const whole = plan.keep.size === 0 && !(await store.exists(to));
    if (whole) return move ? store.move(from, to) : store.copy(from, to);
    if (plan.stats.kind === "file") await store.write(to, store.read(from));
    else {
      await store.mkdir(to);
      for (const e of plan.visible) {
        if (e.kind === "directory") await store.mkdir(targetOf(e.path));
        else await store.write(targetOf(e.path), store.read(e.path));
      }
    }
    if (move) await removeVisible(from, plan);
    return true;
  }
}
