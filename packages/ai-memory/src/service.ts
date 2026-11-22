// The memory service (statewalker/statewalker-root#157): the only writer of memory. It works on one
// composite FilesApi per agent session (or per person, through the memory API) whose folders are
// the kinds it may reach, `/preferences`, `/user`, `/project` and `/agent`, each laid out as
//   entries/<id>.md            one entry (a ULID id), front matter stamped by the server
//   files/<name>.md            an attachment, linked from entries with ordinary Markdown links
//   history/<id>/<version>.md  earlier versions of entries and attachments, and tombstones' bodies
// The memory tool and the memory API run the same batch: one atomic list of actions on one kind,
// checked whole (links, scans, caps) before anything is written, and serialized per kind.
import { type CodedError, codedError } from "@statewalker/ai-access";
import type { FilesApi } from "@statewalker/webrun-files";
import { readText, writeText } from "@statewalker/webrun-files";
import { CompositeFilesApi } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { sealed, unsealed } from "./front-matter.js";
import { capsOf, MEMORY_KINDS, type MemoryCaps, type MemoryKind, type Writer } from "./kinds.js";
import { searchRegExp } from "./regex.js";
import { scanText } from "./scan.js";
import { ULID, ulid } from "./ulid.js";

/** One action of a batch. `erase` is not one: only a person erases, through `erase`. */
export type MemoryAction =
  | {
      op: "add";
      body: string;
      title?: string;
      type?: string;
      attributes?: Record<string, unknown>;
      references?: MemoryReference[];
    }
  | {
      op: "patch";
      id: string;
      /** The new body; or `old` and `new`: replace the one occurrence of `old`. */
      body?: string;
      old?: string;
      new?: string;
      title?: string;
      type?: string;
      attributes?: Record<string, unknown>;
      references?: MemoryReference[];
    }
  | { op: "forget"; id: string }
  | { op: "read"; name: string }
  | { op: "write"; name: string; body: string; description?: string }
  | { op: "delete"; name: string }
  | { op: "search"; query: string; regex?: boolean };

/** A reference from an entry to a record elsewhere (reserved, kept as given). */
export interface MemoryReference {
  rel: string;
  memory_id?: string;
  record_id?: string;
}

export interface SearchMatch {
  /** The entry's id, or the attachment's name. */
  id?: string;
  name?: string;
  text: string;
}

export interface ActionResult {
  op: MemoryAction["op"];
  id?: string;
  version?: number;
  name?: string;
  description?: string;
  body?: string;
  matches?: SearchMatch[];
}

export interface MemoryUsage {
  entries: { used: number; cap: number; count: number };
  files: { used: number; cap: number; file_cap: number; count: number };
}

export interface EntryView {
  id: string;
  version: number;
  supersedes?: number | null;
  written_by: Writer;
  created: string;
  modified: string;
  type: string;
  title?: string;
  status: string;
  body: string;
  attributes?: Record<string, unknown>;
  references?: MemoryReference[];
  forgotten_at?: string;
  forgotten_by?: Writer;
  /** Why the scans at load block it: it is not primed. */
  blocked?: string;
}

export interface FileView {
  id: string;
  name: string;
  description?: string;
  written_by?: Writer;
  modified?: string;
  version?: number;
  body?: string;
}

export interface Skipped {
  path: string;
  reason: string;
}

/** One kind as a person sees it through the memory API. */
export interface KindView {
  kind: MemoryKind;
  entries: EntryView[];
  forgotten: EntryView[];
  files: FileView[];
  usage: MemoryUsage;
  skipped: Skipped[];
}

export interface BatchResult {
  kind: MemoryKind;
  results: ActionResult[];
  usage: MemoryUsage;
}

/** Every kind primed whole, at session start and after each compaction. */
export interface MemorySnapshot {
  kinds: { kind: MemoryKind; entries: EntryView[]; files: FileView[]; usage: MemoryUsage }[];
  flagged: { kind: MemoryKind; id: string; reason: string }[];
  skipped: (Skipped & { kind: MemoryKind })[];
}

/** Serializes work per key, across every service sharing it (one per Durable Object). */
export class KeyedLock {
  readonly #tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.#tails.get(key) ?? Promise.resolve();
    const mine = before.then(work, work);
    const tail = mine.catch(() => {});
    this.#tails.set(key, tail);
    try {
      return await mine;
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

export interface MemoryServiceOptions {
  /** The composite FilesApi: one folder per kind (`memoryFiles`). */
  files: FilesApi;
  /** The kinds it holds (default: all four). Any other answers ENOENT. */
  kinds?: readonly MemoryKind[];
  caps?: MemoryCaps;
  now?: () => number;
  /** The values of the secrets stored for the caller's scope: never written into memory. */
  secretValues?: () => Promise<readonly string[]>;
  /**
   * Scans texts where the secrets are (one call per operation): why each may not be memory, or
   * undefined. Instead of `secretValues`, when the values live in another Durable Object.
   */
  scan?: (texts: string[]) => Promise<(string | undefined)[]>;
  /** Refuses (ENOSPC) a batch adding `delta` bytes over a storage limit, before it writes. */
  admit?: (kind: MemoryKind, delta: number) => Promise<void>;
  /** The lock writes are serialized by, and each kind's key in it. */
  lock?: KeyedLock;
  lockKey?: (kind: MemoryKind) => string;
}

/**
 * The per-session composite FilesApi: each kind's store mounted at `/<kind>`. Nothing else is in
 * it, and no file view shows it.
 */
export function memoryFiles(stores: Partial<Record<MemoryKind, FilesApi>>): FilesApi {
  const composite = new CompositeFilesApi(new MemFilesApi());
  for (const kind of MEMORY_KINDS) {
    const store = stores[kind];
    if (store) composite.mount(`/${kind}`, store);
  }
  return composite;
}

interface Loaded {
  data: Record<string, unknown>;
  body: string;
  text: string;
}

interface State {
  entries: Map<string, Loaded>;
  files: Map<string, Loaded>;
  skipped: Skipped[];
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LINK = /\]\(\s*(?:\.\/)?files\/([^)\s#?]+?)(?:\.md)?\s*\)/g;
const MAX_QUERY = 512;
const MAX_TEXT = 65536;

const chars = (s: string) => [...s].length;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The names of the own attachments a body links to. */
function linksOf(body: string): string[] {
  return [...body.matchAll(LINK)].map((m) => String(m[1]));
}

function nameOf(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\.md$/, "") : "";
  if (!NAME.test(name))
    throw codedError("EINVAL", "an attachment's name is 1-64 of a-z, 0-9, '-' and '_'");
  return name;
}

function textOf(raw: unknown, what: string): string {
  if (typeof raw !== "string") throw codedError("EINVAL", `${what} must be text`);
  if (raw.length > MAX_TEXT) throw codedError("EINVAL", `${what} is too long`);
  return raw;
}

const optionalText = (raw: unknown, what: string) =>
  raw === undefined ? undefined : textOf(raw, what).slice(0, 200);

function objectOf(raw: unknown, what: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw codedError("EINVAL", `${what} must be an object`);
  return raw as Record<string, unknown>;
}

function referencesOf(raw: unknown): MemoryReference[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw codedError("EINVAL", "references must be a list");
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.rel !== "string") throw codedError("EINVAL", "a reference has a rel");
    return {
      rel: o.rel,
      ...(typeof o.memory_id === "string" ? { memory_id: o.memory_id } : {}),
      ...(typeof o.record_id === "string" ? { record_id: o.record_id } : {}),
    };
  });
}

/** An entry as the API and priming show it. */
function entryView(l: Loaded): EntryView {
  const d = l.data;
  return {
    id: String(d.id),
    version: Number(d.version),
    ...(d.supersedes !== undefined ? { supersedes: d.supersedes as number | null } : {}),
    written_by: d.written_by as Writer,
    created: String(d.created),
    modified: String(d.modified),
    type: String(d.type ?? "note"),
    ...(typeof d.title === "string" ? { title: d.title } : {}),
    status: String(d.status ?? "active"),
    body: l.body,
    ...(d.attributes && typeof d.attributes === "object"
      ? { attributes: d.attributes as Record<string, unknown> }
      : {}),
    ...(Array.isArray(d.references) ? { references: d.references as MemoryReference[] } : {}),
    ...(d.forgotten_at ? { forgotten_at: String(d.forgotten_at) } : {}),
    ...(d.forgotten_by ? { forgotten_by: d.forgotten_by as Writer } : {}),
  };
}

function fileView(l: Loaded, withBody = false): FileView {
  const d = l.data;
  return {
    id: String(d.id),
    name: String(d.name),
    ...(typeof d.description === "string" ? { description: d.description } : {}),
    ...(d.written_by ? { written_by: d.written_by as Writer } : {}),
    ...(d.modified ? { modified: String(d.modified) } : {}),
    ...(d.version !== undefined ? { version: Number(d.version) } : {}),
    ...(withBody ? { body: l.body } : {}),
  };
}

const active = (l: Loaded) => (l.data.status ?? "active") === "active";

export class MemoryService {
  readonly #o: MemoryServiceOptions;
  readonly #lock: KeyedLock;
  readonly #kinds: readonly MemoryKind[];

  constructor(options: MemoryServiceOptions) {
    this.#o = options;
    this.#lock = options.lock ?? new KeyedLock();
    this.#kinds = options.kinds ?? MEMORY_KINDS;
  }

  #root(kind: MemoryKind): string {
    if (!this.#kinds.includes(kind)) throw codedError("ENOENT", `no ${kind} memory here`);
    return `/${kind}`;
  }

  #now(): string {
    return new Date(this.#o.now?.() ?? Date.now()).toISOString();
  }

  #locked<T>(kind: MemoryKind, work: () => Promise<T>): Promise<T> {
    return this.#lock.run(this.#o.lockKey?.(kind) ?? kind, work);
  }

  /** Why each text may not be memory (the scans), or undefined. */
  async #scan(texts: string[]): Promise<(string | undefined)[]> {
    if (!texts.length) return [];
    if (this.#o.scan) return this.#o.scan(texts);
    const values = (await this.#o.secretValues?.()) ?? [];
    return texts.map((t) => scanText(t, values));
  }

  async #load(kind: MemoryKind): Promise<State> {
    const root = this.#root(kind);
    const files = this.#o.files;
    const state: State = { entries: new Map(), files: new Map(), skipped: [] };
    const each = async (folder: string, into: (l: Loaded, name: string, path: string) => void) => {
      if (!(await files.exists(`${root}/${folder}`))) return;
      for await (const e of files.list(`${root}/${folder}`)) {
        if (e.kind !== "file" || !e.name.endsWith(".md")) continue;
        const path = `/${folder}/${e.name}`;
        const text = await readText(files, `${root}${path}`);
        const fm = await unsealed(text);
        if ("problem" in fm) state.skipped.push({ path, reason: fm.problem });
        else into({ ...fm, text }, e.name.slice(0, -3), path);
      }
    };
    await each("entries", (l, name, path) => {
      if (l.data.id !== name || !ULID.test(name))
        state.skipped.push({ path, reason: "its id does not match its file" });
      else state.entries.set(name, l);
    });
    await each("files", (l, name, path) => {
      if (l.data.name !== name)
        state.skipped.push({ path, reason: "its name does not match its file" });
      else state.files.set(name, l);
    });
    return state;
  }

  #usage(kind: MemoryKind, state: Pick<State, "entries" | "files">): MemoryUsage {
    const caps = capsOf(this.#o.caps, kind);
    const live = [...state.entries.values()].filter(active);
    return {
      entries: {
        used: live.reduce((n, l) => n + chars(l.body), 0),
        cap: caps.entries,
        count: live.length,
      },
      files: {
        used: [...state.files.values()].reduce((n, l) => n + bytes(l.body), 0),
        cap: caps.files,
        file_cap: caps.file,
        count: state.files.size,
      },
    };
  }

  /** One kind whole, as a person sees it: entries (blocked ones flagged), tombstones, attachments. */
  async list(kind: MemoryKind): Promise<KindView> {
    const state = await this.#load(kind);
    const entries: EntryView[] = [];
    const forgotten: EntryView[] = [];
    const live = [...state.entries.values()].sort(byCreated).filter((l) => {
      if (!active(l)) forgotten.push(entryView(l));
      return active(l);
    });
    const reasons = await this.#scan(live.map(entryText));
    for (const [i, l] of live.entries()) {
      const blocked = reasons[i];
      entries.push(blocked ? { ...entryView(l), blocked } : entryView(l));
    }
    return {
      kind,
      entries,
      forgotten,
      files: [...state.files.values()].map((l) => fileView(l)),
      usage: this.#usage(kind, state),
      skipped: state.skipped,
    };
  }

  /** One entry with its earlier versions (newest first); ENOENT when there is none. */
  async entry(kind: MemoryKind, id: string): Promise<EntryView & { history: EntryView[] }> {
    const state = await this.#load(kind);
    const l = state.entries.get(String(id));
    if (!l) throw codedError("ENOENT", "no such memory entry");
    const history: EntryView[] = [];
    const folder = `${this.#root(kind)}/history/${id}`;
    if (await this.#o.files.exists(folder))
      for await (const e of this.#o.files.list(folder)) {
        if (e.kind !== "file") continue;
        const fm = await unsealed(await readText(this.#o.files, `${folder}/${e.name}`));
        if (!("problem" in fm)) history.push(entryView({ ...fm, text: "" }));
      }
    history.sort((a, b) => b.version - a.version);
    return { ...entryView(l), history };
  }

  /** One attachment with its body; ENOENT when there is none. */
  async file(kind: MemoryKind, name: string): Promise<FileView> {
    const state = await this.#load(kind);
    const l = state.files.get(nameOf(name));
    if (!l) throw codedError("ENOENT", "no such memory attachment");
    return fileView(l, true);
  }

  /** Every kind whole, as the agent is primed with it; blocked and skipped entries reported. */
  async prime(kinds: readonly MemoryKind[]): Promise<MemorySnapshot> {
    const snapshot: MemorySnapshot = { kinds: [], flagged: [], skipped: [] };
    const states = new Map<MemoryKind, State>();
    for (const kind of kinds) states.set(kind, await this.#load(kind));
    const all = [...states].flatMap(([kind, state]) =>
      [...state.entries.values()]
        .filter(active)
        .sort(byCreated)
        .map((l) => ({ kind, l })),
    );
    const reasons = await this.#scan(all.map(({ l }) => entryText(l)));
    for (const kind of kinds) {
      const state = states.get(kind) as State;
      const entries: EntryView[] = [];
      for (const [i, { kind: k, l }] of all.entries()) {
        if (k !== kind) continue;
        const blocked = reasons[i];
        if (blocked) snapshot.flagged.push({ kind, id: String(l.data.id), reason: blocked });
        else entries.push(entryView(l));
      }
      snapshot.kinds.push({
        kind,
        entries,
        files: [...state.files.values()].map((l) => {
          const { id, name, description } = fileView(l);
          return { id, name, ...(description ? { description } : {}) };
        }),
        usage: this.#usage(kind, state),
      });
      for (const s of state.skipped) snapshot.skipped.push({ kind, ...s });
    }
    return snapshot;
  }

  /**
   * One atomic batch of actions on one kind, `writer` stamped on what it writes. Checked whole
   * (links to own attachments, the scans, the caps) before anything is written; a failing action
   * leaves nothing of the batch.
   */
  async batch(
    kind: MemoryKind,
    actions: readonly MemoryAction[],
    writer: Writer,
  ): Promise<BatchResult> {
    this.#root(kind);
    if (!Array.isArray(actions) || actions.length === 0)
      throw codedError("EINVAL", "a batch is a non-empty list of actions");
    if (actions.length > 64) throw codedError("EINVAL", "a batch holds at most 64 actions");
    return this.#locked(kind, () => this.#batch(kind, actions, writer));
  }

  async #batch(
    kind: MemoryKind,
    actions: readonly MemoryAction[],
    writer: Writer,
  ): Promise<BatchResult> {
    const root = this.#root(kind);
    const state = await this.#load(kind);
    const before = this.#usage(kind, state);
    const entries = new Map(state.entries);
    const files = new Map(state.files);
    const skippedPaths = new Set(state.skipped.map((s) => s.path));
    const linkedBefore = new Set(
      [...state.entries.values()].filter(active).flatMap((l) => linksOf(l.body)),
    );
    const now = this.#now();
    /** Path (relative to the kind) → its new text, or null to remove it. */
    const writes = new Map<string, string | null>();
    const touchedEntries = new Set<string>();
    const touchedFiles = new Set<string>();
    const pending: { path: string; data: Record<string, unknown>; body: string }[] = [];
    const results: ActionResult[] = [];
    const toHistory = (folderId: string, l: Loaded) =>
      writes.set(`/history/${folderId}/${Number(l.data.version)}.md`, l.text);
    const existing = (id: unknown): Loaded => {
      const key = String(id);
      if (skippedPaths.has(`/entries/${key}.md`))
        throw codedError("EINVAL", `entry ${key} was changed outside the memory service`);
      const l = entries.get(key);
      if (!l || !active(l)) throw codedError("ENOENT", `no memory entry ${key}`);
      return l;
    };
    const put = (id: string, data: Record<string, unknown>, body: string) => {
      entries.set(id, { data, body, text: "" });
      pending.push({ path: `/entries/${id}.md`, data, body });
      touchedEntries.add(id);
    };
    const putFile = (name: string, data: Record<string, unknown>, body: string) => {
      files.set(name, { data, body, text: "" });
      pending.push({ path: `/files/${name}.md`, data, body });
      touchedFiles.add(name);
    };
    const forgetFile = (name: string) => {
      const l = files.get(name);
      if (!l) return;
      if (l.text) toHistory(String(l.data.id), l);
      files.delete(name);
      writes.set(`/files/${name}.md`, null);
      pending.splice(0, pending.length, ...pending.filter((p) => p.path !== `/files/${name}.md`));
    };
    for (const [i, raw] of actions.entries()) {
      const action = (raw ?? {}) as Record<string, unknown>;
      try {
        switch (action.op) {
          case "add": {
            const id = ulid(this.#o.now?.() ?? Date.now());
            const title = optionalText(action.title, "title");
            put(
              id,
              {
                id,
                written_by: writer,
                created: now,
                modified: now,
                version: 1,
                supersedes: null,
                type: optionalText(action.type, "type") ?? "note",
                ...(title !== undefined ? { title } : {}),
                status: "active",
                attributes: objectOf(action.attributes, "attributes") ?? {},
                references: referencesOf(action.references) ?? [],
              },
              textOf(action.body, "body"),
            );
            results.push({ op: "add", id, version: 1 });
            break;
          }
          case "patch": {
            const l = existing(action.id);
            let body = l.body;
            if (action.body !== undefined) body = textOf(action.body, "body");
            else if (action.old !== undefined) {
              const old = textOf(action.old, "old");
              const by = textOf(action.new ?? "", "new");
              const n = old ? body.split(old).length - 1 : 0;
              if (n !== 1)
                throw codedError(
                  "EINVAL",
                  n === 0 ? "old does not occur in the entry" : `old occurs ${n} times`,
                );
              body = body.replace(old, () => by);
            }
            if (l.text) toHistory(String(l.data.id), l);
            const version = Number(l.data.version) + 1;
            const title = optionalText(action.title, "title");
            const type = optionalText(action.type, "type");
            const attributes = objectOf(action.attributes, "attributes");
            const references = referencesOf(action.references);
            put(
              String(l.data.id),
              {
                ...l.data,
                written_by: writer,
                modified: now,
                version,
                supersedes: Number(l.data.version),
                ...(type !== undefined ? { type } : {}),
                ...(title !== undefined ? { title } : {}),
                ...(attributes ? { attributes } : {}),
                ...(references ? { references } : {}),
              },
              body,
            );
            results.push({ op: "patch", id: String(l.data.id), version });
            break;
          }
          case "forget": {
            const l = existing(action.id);
            if (l.text) toHistory(String(l.data.id), l);
            const version = Number(l.data.version) + 1;
            put(
              String(l.data.id),
              {
                ...l.data,
                modified: now,
                version,
                supersedes: Number(l.data.version),
                status: "forgotten",
                forgotten_at: now,
                forgotten_by: writer,
              },
              "",
            );
            results.push({ op: "forget", id: String(l.data.id), version });
            break;
          }
          case "read": {
            const name = nameOf(action.name);
            const l = files.get(name);
            if (!l) throw codedError("ENOENT", `no memory attachment ${name}`);
            results.push({ op: "read", ...fileView(l, true) });
            break;
          }
          case "write": {
            const name = nameOf(action.name);
            if (skippedPaths.has(`/files/${name}.md`))
              throw codedError(
                "EINVAL",
                `attachment ${name} was changed outside the memory service`,
              );
            const old = files.get(name);
            if (old?.text) toHistory(String(old.data.id), old);
            const version = old ? Number(old.data.version ?? 1) + 1 : 1;
            const description = optionalText(action.description, "description");
            putFile(
              name,
              {
                ...(old?.data ?? {}),
                id: old ? String(old.data.id) : ulid(this.#o.now?.() ?? Date.now()),
                name,
                ...(description !== undefined ? { description } : {}),
                written_by: writer,
                modified: now,
                version,
              },
              textOf(action.body, "body"),
            );
            results.push({ op: "write", name, version });
            break;
          }
          case "delete": {
            const name = nameOf(action.name);
            if (!files.has(name)) throw codedError("ENOENT", `no memory attachment ${name}`);
            const linker = [...entries.values()].find(
              (l) => active(l) && linksOf(l.body).includes(name),
            );
            if (linker)
              throw codedError(
                "EINVAL",
                `attachment ${name} is linked from entry ${String(linker.data.id)}`,
              );
            forgetFile(name);
            results.push({ op: "delete", name });
            break;
          }
          case "search": {
            const query = textOf(action.query, "query");
            if (!query || query.length > MAX_QUERY)
              throw codedError("EINVAL", `a query is 1-${MAX_QUERY} characters`);
            let test: (line: string) => boolean;
            if (action.regex === true) {
              const re = searchRegExp(query);
              test = (line) => re.test(line);
            } else {
              const q = query.toLowerCase();
              test = (line) => line.toLowerCase().includes(q);
            }
            const matches: SearchMatch[] = [];
            for (const l of [...entries.values()].filter(active).sort(byCreated))
              for (const line of `${l.data.title ?? ""}\n${l.body}`.split("\n"))
                if (line && test(line)) matches.push({ id: String(l.data.id), text: line });
            for (const l of files.values())
              for (const line of l.body.split("\n"))
                if (line && test(line)) matches.push({ name: String(l.data.name), text: line });
            results.push({ op: "search", matches });
            break;
          }
          default:
            throw codedError("EINVAL", `no action '${String(action.op)}'`);
        }
      } catch (e) {
        throw prefixed(e, `action ${i + 1} (${String(action.op)})`);
      }
    }
    // An attachment no longer linked from any entry goes with the last entry that linked to it.
    const linkedAfter = new Set(
      [...entries.values()].filter(active).flatMap((l) => linksOf(l.body)),
    );
    for (const name of linkedBefore) if (!linkedAfter.has(name)) forgetFile(name);
    // Links to own attachments must point at one (references to other memory are kept as they are).
    for (const id of touchedEntries) {
      const l = entries.get(id) as Loaded;
      if (!active(l)) continue;
      for (const name of linksOf(l.body))
        if (!files.has(name))
          throw codedError("EINVAL", `entry ${id} links to a missing attachment '${name}'`);
    }
    // The scans: nothing written may carry injection, exfiltration or a secret.
    const scanned = [
      ...[...touchedEntries]
        .filter((id) => active(entries.get(id) as Loaded))
        .map((id) => ({ what: `entry ${id}`, text: entryText(entries.get(id) as Loaded) })),
      ...[...touchedFiles].flatMap((name) => {
        const l = files.get(name);
        return l
          ? [{ what: `attachment ${name}`, text: `${l.data.description ?? ""}\n${l.body}` }]
          : [];
      }),
    ];
    const reasons = await this.#scan(scanned.map((s) => s.text));
    for (const [i, s] of scanned.entries())
      if (reasons[i]) throw codedError("EINVAL", `${s.what}: ${reasons[i]}`);
    // The caps: a batch may leave a kind over a cap only if it shrinks it.
    const after = this.#usage(kind, { entries, files });
    if (after.entries.used > after.entries.cap && after.entries.used > before.entries.used)
      throw codedError(
        "ENOSPC",
        `${kind} memory is full: its entries would hold ${after.entries.used} / ${after.entries.cap} characters; consolidate (patch or forget) in the same call\n${stateText(kind, state, before)}`,
      );
    for (const name of touchedFiles) {
      const l = files.get(name);
      if (l && bytes(l.body) > after.files.file_cap)
        throw codedError(
          "ENOSPC",
          `attachment ${name} holds ${bytes(l.body)} bytes, over the cap of ${after.files.file_cap}\n${stateText(kind, state, before)}`,
        );
    }
    if (after.files.used > after.files.cap && after.files.used > before.files.used)
      throw codedError(
        "ENOSPC",
        `${kind} memory's attachments would hold ${after.files.used} / ${after.files.cap} bytes\n${stateText(kind, state, before)}`,
      );
    for (const p of pending) writes.set(p.path, await sealed(p.data, p.body));
    // Storage limits: refused before anything lands.
    let delta = 0;
    for (const [path, text] of writes) {
      const old = path.startsWith("/entries/")
        ? state.entries.get(path.slice(9, -3))?.text
        : path.startsWith("/files/")
          ? state.files.get(path.slice(7, -3))?.text
          : undefined;
      delta += (text === null ? 0 : bytes(text)) - (old ? bytes(old) : 0);
    }
    if (delta > 0) await this.#o.admit?.(kind, delta);
    // History first, so an interrupted batch never loses a version; removals last.
    const order = [...writes].sort(([a, x], [b, y]) => rank(a, x) - rank(b, y));
    for (const [path, text] of order) {
      if (text === null) await this.#o.files.remove(`${root}${path}`);
      else await writeText(this.#o.files, `${root}${path}`, text);
    }
    return { kind, results, usage: after };
  }

  /**
   * Erases an entry (with its history and tombstone) or an attachment (with its history): only a
   * person does this, never the memory tool. Files changed outside the service are erased too.
   */
  async erase(kind: MemoryKind, target: { id?: string; name?: string }): Promise<{ erased: true }> {
    const root = this.#root(kind);
    return this.#locked(kind, async () => {
      const files = this.#o.files;
      if (target.id !== undefined) {
        const id = String(target.id);
        if (!ULID.test(id)) throw codedError("ENOENT", "no such memory entry");
        const entry = `${root}/entries/${id}.md`;
        const history = `${root}/history/${id}`;
        if (!(await files.exists(entry)) && !(await files.exists(history)))
          throw codedError("ENOENT", "no such memory entry");
        await files.remove(entry);
        await files.remove(history);
        return { erased: true };
      }
      const name = nameOf(target.name);
      const path = `${root}/files/${name}.md`;
      if (!(await files.exists(path))) throw codedError("ENOENT", "no such memory attachment");
      const fm = await unsealed(await readText(files, path));
      await files.remove(path);
      if (!("problem" in fm) && typeof fm.data.id === "string" && ULID.test(fm.data.id))
        await files.remove(`${root}/history/${fm.data.id}`);
      return { erased: true };
    });
  }

  /** Erases a whole kind: every entry, attachment and version (a project deleted, an agent removed). */
  async eraseKind(kind: MemoryKind): Promise<void> {
    const root = this.#root(kind);
    return this.#locked(kind, async () => {
      for (const folder of ["entries", "files", "history"])
        await this.#o.files.remove(`${root}/${folder}`);
    });
  }

  /**
   * Sets `written_by` and `forgotten_by` of a user to `replacement` in every file of the kind that
   * the service wrote (history included): an erased user's entries stay, by the "deleted user".
   */
  async replaceAuthor(kind: MemoryKind, user: string, replacement: string): Promise<number> {
    const root = this.#root(kind);
    return this.#locked(kind, async () => {
      const files = this.#o.files;
      if (!(await files.exists(root))) return 0;
      let changed = 0;
      for await (const e of files.list(root, { recursive: true })) {
        if (e.kind !== "file" || !e.name.endsWith(".md")) continue;
        const path = e.path.startsWith(root) ? e.path : `${root}${e.path}`;
        const fm = await unsealed(await readText(files, path));
        if ("problem" in fm) continue;
        const data = { ...fm.data };
        let hit = false;
        for (const key of ["written_by", "forgotten_by"]) {
          const w = data[key] as Writer | undefined;
          if (w && typeof w === "object" && w.user === user) {
            data[key] = { user: replacement };
            hit = true;
          }
        }
        if (!hit) continue;
        await writeText(files, path, await sealed(data, fm.body));
        changed++;
      }
      return changed;
    });
  }
}

/** What the scans read of an entry: its title and body. */
const entryText = (l: Loaded) =>
  `${typeof l.data.title === "string" ? l.data.title : ""}\n${l.body}`;

const byCreated = (a: Loaded, b: Loaded) => String(a.data.id).localeCompare(String(b.data.id));

/** History before entries and attachments, removals last. */
const rank = (path: string, text: string | null) =>
  text === null ? 2 : path.startsWith("/history/") ? 0 : 1;

/** The current state of a kind, as a refused batch shows it so the agent can consolidate. */
function stateText(kind: MemoryKind, state: State, usage: MemoryUsage): string {
  const lines = [
    `current ${kind} memory: ${usage.entries.used} / ${usage.entries.cap} characters in ${usage.entries.count} entries; attachments ${usage.files.used} / ${usage.files.cap} bytes`,
  ];
  for (const l of [...state.entries.values()].filter(active).sort(byCreated))
    lines.push(
      `- ${String(l.data.id)} (${chars(l.body)} characters): ${l.body.replace(/\s+/g, " ")}`,
    );
  for (const l of state.files.values())
    lines.push(`- files/${String(l.data.name)}.md (${bytes(l.body)} bytes)`);
  return lines.join("\n");
}

/** The error with `where` after its code. */
function prefixed(e: unknown, where: string): CodedError {
  const message = String((e as Error)?.message ?? e);
  const m = /^(E[A-Z]+): ([\s\S]*)$/.exec(message);
  const code = (m?.[1] ?? "EINVAL") as CodedError["code"];
  return codedError(code, `${where}: ${m?.[2] ?? message}`);
}
