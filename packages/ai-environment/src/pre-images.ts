// File pre-images (statewalker/statewalker-root#191, decided in #159): the gate keeps, owner-side,
// the state a file had before an agent session's turn first wrote, deleted or moved it, so a
// rewind can put files back as they were before the turns it rewinds, only where nobody changed
// them since. Every change an agent session makes through the gate is one record of the log (the
// file's digest before and after, its session, the session's lineage and the turn); the first
// record of a turn on a file keeps the file's content before it (its pre-image) while the
// retention allows. The records are tiny and stay while their session does, so a rewind past the
// pre-images still says which files it could not revert.
//
// New tables only (pre_image_records, pre_image_blobs, pre_image_chunks), in the gate's own
// SQLite, which no file view reaches: rolling back leaves them unused.
import type { FilesApi } from "@statewalker/webrun-files";
import { normalise } from "./paths.js";
import type { SqlLike } from "./sql.js";

/** Who changes files through the gate: an agent session, its lineage (root first) and its turn. */
export interface PreImageActor {
  session: string;
  /** The session's ancestors, root first, then the session itself. */
  lineage: readonly string[];
  /** The turn the change belongs to; none for the gate's own writes (a revert). */
  turn?: string;
}

/** How long pre-images are kept: by age, and by bytes per top-level session (oldest go first). */
export interface PreImageRetention {
  maxAgeMs: number;
  maxBytes: number;
}

export const DEFAULT_PRE_IMAGE_RETENTION: PreImageRetention = {
  maxAgeMs: 30 * 24 * 3600_000,
  maxBytes: 100 * 1024 * 1024,
};

/**
 * A retention from its text (`{"days": 30, "megabytes": 100}`), over `base`: what is missing or
 * not a non-negative number keeps the base's value.
 */
export function parsePreImageRetention(
  text: string | undefined | null,
  base: PreImageRetention = DEFAULT_PRE_IMAGE_RETENTION,
): PreImageRetention {
  if (!text?.trim()) return base;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return base;
  }
  const r = (raw ?? {}) as { days?: unknown; megabytes?: unknown };
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return {
    maxAgeMs: ok(r.days) ? r.days * 24 * 3600_000 : base.maxAgeMs,
    maxBytes: ok(r.megabytes) ? Math.floor(r.megabytes * 1024 * 1024) : base.maxBytes,
  };
}

/** Bytes kept or freed in a project's files meter. */
export interface StorageDelta {
  project: string;
  bytes: number;
}

/** What a revert did with the files rewound turns changed (paths as the file view names them). */
export interface FilesRevert {
  /** Restored to their state before the first rewound turn that changed them. */
  reverted: string[];
  /** Changed since by someone else: left alone. */
  conflicts: string[];
  /** Their pre-image is no longer kept (retention, or dropped): left alone. */
  unavailable: string[];
}

/** What a rewind's revert covers: some turns of a session, and every change of some sub-agents. */
export interface RevertScope {
  session: string;
  turns: readonly string[];
  /** Sub-agent sessions (and so their descendants) whose every change is reverted too. */
  children: readonly string[];
}

/** One file a revert restores: absent (`image` none and `absent`) or the content of a pre-image. */
export interface RevertStep {
  path: string;
  absent: boolean;
  image?: number;
}

/** A revert worked out against the files as they are now; `apply` carries out its steps. */
export interface RevertPlan extends FilesRevert {
  steps: RevertStep[];
}

interface RecordRow {
  seq: number;
  project: string;
  path: string;
  session: string;
  lineage: string;
  turn: string | null;
  pre: string;
  post: string;
  image: number | null;
  kept: number;
}

const BLOCK = 1024 * 1024;
const CHUNK = 512 * 1024;
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);

/**
 * A content digest built as the content streams: SHA-256 over fixed blocks, then over the blocks'
 * digests and the length, so the same content has the same digest however it was chunked.
 */
export class ContentDigest {
  #parts: Uint8Array[] = [];
  #buffered = 0;
  #length = 0;
  readonly #blocks: Promise<ArrayBuffer>[] = [];

  push(chunk: Uint8Array): void {
    this.#length += chunk.length;
    let rest = chunk;
    while (rest.length) {
      const take = Math.min(rest.length, BLOCK - this.#buffered);
      this.#parts.push(rest.subarray(0, take));
      this.#buffered += take;
      rest = rest.subarray(take);
      if (this.#buffered === BLOCK) this.#flush();
    }
  }

  #flush(): void {
    const block = new Uint8Array(this.#buffered);
    let at = 0;
    for (const p of this.#parts) {
      block.set(p, at);
      at += p.length;
    }
    this.#parts = [];
    this.#buffered = 0;
    this.#blocks.push(crypto.subtle.digest("SHA-256", block));
  }

  async done(): Promise<string> {
    if (this.#buffered || !this.#blocks.length) this.#flush();
    const blocks = await Promise.all(this.#blocks);
    const all = new Uint8Array(blocks.length * 32 + 8);
    blocks.forEach((b, i) => {
      all.set(new Uint8Array(b), i * 32);
    });
    new DataView(all.buffer).setFloat64(blocks.length * 32, this.#length);
    return hex(await crypto.subtle.digest("SHA-256", all));
  }
}

/** The digest of a file as it is now; "" when there is no file. */
export async function digestOf(store: FilesApi, path: string): Promise<string> {
  const st = await store.stats(path);
  if (st?.kind !== "file") return "";
  const d = new ContentDigest();
  for await (const chunk of store.read(path)) d.push(chunk);
  return d.done();
}

const projectOf = (path: string) => path.split("/").filter(Boolean)[0] ?? "";
const lineageText = (lineage: readonly string[]) => `,${lineage.join(",")},`;

/** The gate's log of agent sessions' file changes and the pre-images they keep. */
export class PreImageLog {
  readonly #sql: SqlLike;
  readonly #now: () => number;

  constructor(sql: SqlLike, options: { now?: () => number } = {}) {
    this.#sql = sql;
    this.#now = options.now ?? Date.now;
    sql.exec(`CREATE TABLE IF NOT EXISTS pre_image_records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, path TEXT NOT NULL,
      session TEXT NOT NULL, root TEXT NOT NULL, lineage TEXT NOT NULL, turn TEXT,
      pre TEXT NOT NULL, post TEXT NOT NULL, image INTEGER, kept INTEGER NOT NULL,
      created INTEGER NOT NULL)`);
    sql.exec(
      "CREATE INDEX IF NOT EXISTS pre_image_records_path ON pre_image_records (project, path, seq)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS pre_image_records_root ON pre_image_records (root)");
    sql.exec(`CREATE TABLE IF NOT EXISTS pre_image_blobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, root TEXT NOT NULL, project TEXT NOT NULL,
      bytes INTEGER NOT NULL, created INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS pre_image_chunks (
      blob INTEGER NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (blob, n))`);
  }

  #rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.#sql.exec(query, ...bindings).toArray() as T[];
  }

  /**
   * Captures a file's state before a change: its digest and, for the first change of the actor's
   * turn to it, its content (a pre-image), unless it is larger than the retention allows. The
   * pre-image's bytes are answered, to count in the files meter; `commit` records the change once
   * done, `abandon` forgets the captured pre-image when the change failed.
   */
  async capture(
    store: FilesApi,
    actor: PreImageActor,
    rawPath: string,
    retention: PreImageRetention,
  ): Promise<Capture> {
    const path = normalise(rawPath);
    const project = projectOf(path);
    const root = actor.lineage[0] ?? actor.session;
    const first =
      actor.turn !== undefined &&
      !this.#rows(
        "SELECT 1 FROM pre_image_records WHERE session = ? AND turn = ? AND project = ? AND path = ? LIMIT 1",
        actor.session,
        actor.turn,
        project,
        path,
      ).length;
    const st = await store.stats(path);
    const exists = st?.kind === "file";
    let pre = "";
    let image: number | null = null;
    let bytes = 0;
    let kept = first;
    if (exists) {
      const d = new ContentDigest();
      const size = (st as { size: number }).size;
      const keep = first && size <= retention.maxBytes;
      kept = keep;
      if (keep) {
        this.#sql.exec(
          "INSERT INTO pre_image_blobs (root, project, bytes, created) VALUES (?, ?, 0, ?)",
          root,
          project,
          this.#now(),
        );
        image = Number(
          (this.#rows<{ id: number }>("SELECT last_insert_rowid() AS id")[0] as { id: number }).id,
        );
      }
      let n = 0;
      let pending: Uint8Array[] = [];
      let size_ = 0;
      const flush = () => {
        if (image === null || !size_) return;
        const data = new Uint8Array(size_);
        let at = 0;
        for (const p of pending) {
          data.set(p, at);
          at += p.length;
        }
        this.#sql.exec("INSERT INTO pre_image_chunks VALUES (?, ?, ?)", image, n++, data);
        pending = [];
        size_ = 0;
      };
      for await (const chunk of store.read(path)) {
        d.push(chunk);
        bytes += chunk.length;
        if (image !== null) {
          pending.push(chunk);
          size_ += chunk.length;
          if (size_ >= CHUNK) flush();
        }
      }
      flush();
      pre = await d.done();
      if (image !== null)
        this.#sql.exec("UPDATE pre_image_blobs SET bytes = ? WHERE id = ?", bytes, image);
    }
    const log = this;
    return {
      path,
      pre,
      kept: image !== null ? bytes : 0,
      commit(post: string) {
        log.#sql.exec(
          `INSERT INTO pre_image_records (project, path, session, root, lineage, turn, pre, post,
            image, kept, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          project,
          path,
          actor.session,
          root,
          lineageText(actor.lineage.length ? actor.lineage : [actor.session]),
          actor.turn ?? null,
          pre,
          post,
          image,
          kept ? 1 : 0,
          log.#now(),
        );
      },
      abandon() {
        if (image !== null) log.#dropBlobs([image]);
      },
    };
  }

  /**
   * Frees pre-images past the retention: older than its age, then the oldest of the top-level
   * session `root` while it keeps more bytes than allowed. Their records stay (without content).
   */
  prune(root: string, retention: PreImageRetention): StorageDelta[] {
    const old = this.#rows<{ id: number }>(
      "SELECT id FROM pre_image_blobs WHERE created < ?",
      this.#now() - retention.maxAgeMs,
    ).map((r) => Number(r.id));
    const freed = this.#dropBlobs(old);
    let total = Number(
      this.#rows<{ n: number | null }>(
        "SELECT SUM(bytes) AS n FROM pre_image_blobs WHERE root = ?",
        root,
      )[0]?.n ?? 0,
    );
    if (total > retention.maxBytes) {
      const drop: number[] = [];
      for (const b of this.#rows<{ id: number; bytes: number }>(
        "SELECT id, bytes FROM pre_image_blobs WHERE root = ? ORDER BY created, id",
        root,
      )) {
        if (total <= retention.maxBytes) break;
        drop.push(Number(b.id));
        total -= Number(b.bytes);
      }
      freed.push(...this.#dropBlobs(drop));
    }
    return merge(freed);
  }

  /**
   * Drops everything kept for a top-level session (and its sub-agents), or for a project: its
   * records and its pre-images.
   */
  drop(what: { root: string } | { project: string }): StorageDelta[] {
    const [col, value] = "root" in what ? ["root", what.root] : ["project", what.project];
    const blobs = this.#rows<{ id: number }>(
      `SELECT id FROM pre_image_blobs WHERE ${col} = ?`,
      value,
    ).map((r) => Number(r.id));
    const freed = this.#dropBlobs(blobs);
    this.#sql.exec(`DELETE FROM pre_image_records WHERE ${col} = ?`, value);
    return merge(freed);
  }

  /** The log's position: the last record of a top-level session's tree, if any. */
  position(root: string): number | undefined {
    const row = this.#rows<{ seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM pre_image_records WHERE root = ?",
      root,
    )[0];
    return row?.seq === null || row?.seq === undefined ? undefined : Number(row.seq);
  }

  #dropBlobs(ids: number[]): StorageDelta[] {
    if (!ids.length) return [];
    const list = JSON.stringify(ids);
    const rows = this.#rows<{ project: string; bytes: number }>(
      "SELECT project, bytes FROM pre_image_blobs WHERE id IN (SELECT value FROM json_each(?))",
      list,
    );
    this.#sql.exec(
      "DELETE FROM pre_image_chunks WHERE blob IN (SELECT value FROM json_each(?))",
      list,
    );
    this.#sql.exec(
      "DELETE FROM pre_image_blobs WHERE id IN (SELECT value FROM json_each(?))",
      list,
    );
    this.#sql.exec(
      "UPDATE pre_image_records SET image = NULL, kept = 0 WHERE image IN (SELECT value FROM json_each(?))",
      list,
    );
    return rows.map((r) => ({ project: String(r.project), bytes: -Number(r.bytes) }));
  }

  /**
   * Works out a revert against the files as they are now (`store`, unfiltered): for each file the
   * scope changed, the state before its first change in the scope, if nobody changed the file
   * since (every later change is the scope's, each starting where the previous ended, and the
   * file is as the last left it) and its pre-image is kept.
   */
  async plan(store: FilesApi, scope: RevertScope): Promise<RevertPlan> {
    const turns = new Set(scope.turns);
    const children = scope.children.map((c) => `,${c},`);
    const own = `,${scope.session},`;
    const inScope = (r: RecordRow) =>
      r.turn !== null &&
      ((r.session === scope.session && turns.has(r.turn)) ||
        (r.lineage.includes(own) && children.some((c) => r.lineage.includes(c))));
    const firsts = new Map<string, RecordRow>();
    const candidates = this.#rows<RecordRow>(
      `SELECT * FROM pre_image_records WHERE (session = ? AND turn IN (SELECT value FROM json_each(?)))
        OR instr(lineage, ?) > 0 ORDER BY seq`,
      scope.session,
      JSON.stringify([...turns]),
      own,
    );
    for (const r of candidates) {
      if (!inScope(r)) continue;
      const key = `${r.project}\n${r.path}`;
      if (!firsts.has(key)) firsts.set(key, r);
    }
    const plan: RevertPlan = { reverted: [], conflicts: [], unavailable: [], steps: [] };
    const sorted = [...firsts.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const first of sorted) {
      const later = this.#rows<RecordRow>(
        "SELECT * FROM pre_image_records WHERE project = ? AND path = ? AND seq >= ? ORDER BY seq",
        first.project,
        first.path,
        first.seq,
      );
      let ok = true;
      let prev: RecordRow | undefined;
      for (const r of later) {
        if (!inScope(r) || (prev && r.pre !== prev.post)) {
          ok = false;
          break;
        }
        prev = r;
      }
      if (ok && prev && (await digestOf(store, first.path)) !== prev.post) ok = false;
      if (!ok) plan.conflicts.push(first.path);
      else if (!first.kept) plan.unavailable.push(first.path);
      else {
        plan.reverted.push(first.path);
        plan.steps.push(
          first.pre === ""
            ? { path: first.path, absent: true }
            : { path: first.path, absent: false, image: Number(first.image) },
        );
      }
    }
    return plan;
  }

  /** The content of a kept pre-image, chunk by chunk. */
  async *read(image: number): AsyncGenerator<Uint8Array> {
    for (const row of this.#rows<{ data: unknown }>(
      "SELECT data FROM pre_image_chunks WHERE blob = ? ORDER BY n",
      image,
    ))
      yield bytesOf(row.data);
  }

  /**
   * Carries out a plan's steps through `files` (the session's own gated view): each file restored
   * or removed. A step whose pre-image went meanwhile is unavailable instead.
   */
  async apply(files: FilesApi, plan: RevertPlan): Promise<FilesRevert> {
    const out: FilesRevert = {
      reverted: [],
      conflicts: [...plan.conflicts],
      unavailable: [...plan.unavailable],
    };
    for (const step of plan.steps) {
      if (step.absent) {
        if (await files.exists(step.path)) await files.remove(step.path);
      } else {
        const known = this.#rows("SELECT 1 FROM pre_image_blobs WHERE id = ?", step.image).length;
        if (!known) {
          out.unavailable.push(step.path);
          continue;
        }
        await files.write(step.path, this.read(Number(step.image)));
      }
      out.reverted.push(step.path);
    }
    out.unavailable.sort();
    return out;
  }
}

/** A file's state captured before a change. */
export interface Capture {
  path: string;
  pre: string;
  /** Bytes of the pre-image kept (0 when none). */
  kept: number;
  commit(post: string): void;
  abandon(): void;
}

function merge(list: StorageDelta[]): StorageDelta[] {
  const by = new Map<string, number>();
  for (const d of list) by.set(d.project, (by.get(d.project) ?? 0) + d.bytes);
  return [...by].map(([project, bytes]) => ({ project, bytes }));
}

/**
 * A store whose every change by `actor` is recorded in the log first: the file's state before
 * (its pre-image kept per the retention) and after. Pre-images kept and freed count in the files
 * meter (`adjust`).
 */
export function preImaged(
  store: FilesApi,
  options: {
    log: PreImageLog;
    actor: PreImageActor;
    retention: () => PreImageRetention | Promise<PreImageRetention>;
    adjust?: (deltas: StorageDelta[]) => void | Promise<void>;
  },
): FilesApi {
  const { log, actor } = options;
  const root = actor.lineage[0] ?? actor.session;
  /** The files under a path (the path itself for a file). */
  const filesUnder = async (path: string): Promise<string[]> => {
    const st = await store.stats(path);
    if (!st) return [];
    if (st.kind === "file") return [normalise(path)];
    const out: string[] = [];
    for await (const e of store.list(path, { recursive: true }))
      if (e.kind === "file") out.push(normalise(e.path));
    return out;
  };
  /** Captures the paths, runs the change, then records each path's state after it. */
  const recorded = async <T>(paths: string[], change: () => Promise<T>): Promise<T> => {
    const retention = await options.retention();
    const unique = [...new Set(paths)];
    const captures: Capture[] = [];
    try {
      for (const p of unique) captures.push(await log.capture(store, actor, p, retention));
    } catch (e) {
      for (const c of captures) c.abandon();
      throw e;
    }
    let result: T;
    try {
      result = await change();
    } catch (e) {
      for (const c of captures) c.abandon();
      throw e;
    }
    await settle(captures, retention, async (c) => digestOf(store, c.path));
    return result;
  };
  const settle = async (
    captures: Capture[],
    retention: PreImageRetention,
    postOf: (c: Capture) => Promise<string>,
  ) => {
    for (const c of captures) c.commit(await postOf(c));
    const kept = merge(
      captures.filter((c) => c.kept).map((c) => ({ project: projectOf(c.path), bytes: c.kept })),
    );
    const freed = kept.length ? log.prune(root, retention) : [];
    const deltas = merge([...kept, ...freed]).filter((d) => d.bytes);
    if (deltas.length) await options.adjust?.(deltas);
  };
  return {
    read: (path, o) => store.read(path, o),
    list: (path, o) => store.list(path, o),
    stats: (path) => store.stats(path),
    exists: (path) => store.exists(path),
    mkdir: (path) => store.mkdir(path),
    async write(path, content) {
      const retention = await options.retention();
      const capture = await log.capture(store, actor, path, retention);
      const digest = new ContentDigest();
      async function* teed() {
        for await (const chunk of content) {
          digest.push(chunk);
          yield chunk;
        }
      }
      try {
        await store.write(path, teed());
      } catch (e) {
        capture.abandon();
        throw e;
      }
      const post = await digest.done();
      await settle([capture], retention, async () => post);
    },
    async remove(path) {
      return recorded(await filesUnder(path), () => store.remove(path));
    },
    async copy(source, target) {
      const from = normalise(source);
      const to = normalise(target);
      const moved = (await filesUnder(from)).map((p) => to + p.slice(from.length));
      return recorded([...(await filesUnder(to)), ...moved], () => store.copy(source, target));
    },
    async move(source, target) {
      const from = normalise(source);
      const to = normalise(target);
      const sources = await filesUnder(from);
      const moved = sources.map((p) => to + p.slice(from.length));
      return recorded([...sources, ...(await filesUnder(to)), ...moved], () =>
        store.move(source, target),
      );
    },
  };
}
