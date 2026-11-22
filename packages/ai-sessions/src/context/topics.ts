// The session table of contents (statewalker/statewalker-root#157, #174): the third append-only
// table of an Agent DO, beside `items` and `summaries`. Only the summarizer writes it, in a
// compaction call that is given the current topics: each topic it returns either extends a
// current one (a new row with the same id, superseding it, its refs merged) or starts a new one.
// Refs name leaf items only, never summaries. A row records `through_turn`, the turn of the last
// item of the range it was written from (statewalker/statewalker-root#159): on a path of turns,
// the topics are the rows whose `through_turn` is on it, the latest row of each id winning, and
// their refs are cut to the path's items.
import type { SqlLike } from "../sql.js";

/** One topic of a session's table of contents. */
export interface Topic {
  id: string;
  title: string;
  body: string;
  /** The items it draws from (leaf items only). */
  refs: string[];
  /** The turn of the last item of the range it was last written from. */
  through_turn: string;
  updated_at: number;
}

/** A topic as the summarizer returns it: a current topic's id to extend it, none for a new one. */
export interface TopicUpdate {
  id?: string;
  title: string;
  body: string;
  refs: string[];
}

/** How long a topic's title and body may be; longer ones are cut. */
export const MAX_TOPIC_TITLE = 200;
export const MAX_TOPIC_BODY = 2000;
/** The most topics one compaction call writes. */
export const MAX_TOPIC_UPDATES = 20;

interface TopicRow {
  row: number;
  id: string;
  title: string;
  body: string;
  refs: string;
  through_turn: string;
  updated_at: number;
}

const topicOf = (r: TopicRow): Topic => ({
  id: String(r.id),
  title: String(r.title),
  body: String(r.body),
  refs: JSON.parse(String(r.refs)) as string[],
  through_turn: String(r.through_turn),
  updated_at: Number(r.updated_at),
});

/** Which topics: on a path of turns (none: every item, no tree), or every branch's. */
export type TopicScope = { path?: readonly string[] } | { all: true };

export class TopicStore {
  readonly #sql: SqlLike;
  /** The path from the first turn to a turn (for `all`: which rows a later row supersedes). */
  readonly #pathTo: (turn: string) => string[];

  constructor(options: { sql: SqlLike; pathTo?: (turn: string) => string[] }) {
    this.#sql = options.sql;
    this.#pathTo = options.pathTo ?? (() => []);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS topics (row INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, refs TEXT NOT NULL, through_turn TEXT NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS topics_id ON topics (id, row);`);
  }

  #rows(query: string, ...args: unknown[]): TopicRow[] {
    return this.#sql.exec(query, ...args).toArray() as unknown as TopicRow[];
  }

  /**
   * The topics of a scope, in the order they were first written. On a path: the latest row of
   * each id among the rows on it, refs cut to the path's items. `all`: every row no later row of
   * its id supersedes (a later row supersedes it when it was written on a path through it), refs
   * as written.
   */
  list(scope: TopicScope = {}): Topic[] {
    if ("all" in scope) {
      const rows = this.#rows("SELECT * FROM topics ORDER BY row");
      const paths = new Map<string, Set<string>>();
      const pathOf = (turn: string) => {
        const known = paths.get(turn);
        if (known) return known;
        const p = new Set(this.#pathTo(turn));
        paths.set(turn, p);
        return p;
      };
      const live = rows.filter(
        (r, i) =>
          !rows
            .slice(i + 1)
            .some((later) => later.id === r.id && pathOf(later.through_turn).has(r.through_turn)),
      );
      return this.#ordered(rows, live).map(topicOf);
    }
    const path = scope.path;
    const rows = path
      ? this.#rows(
          "SELECT * FROM topics WHERE through_turn IN (SELECT value FROM json_each(?)) ORDER BY row",
          JSON.stringify(path),
        )
      : this.#rows("SELECT * FROM topics ORDER BY row");
    const latest = new Map<string, TopicRow>();
    for (const r of rows) latest.set(r.id, r);
    const topics = this.#ordered(rows, [...latest.values()]).map(topicOf);
    if (!path) return topics;
    // Refs to items off the path are ignored.
    const refs = [...new Set(topics.flatMap((t) => t.refs))];
    const on = new Set(
      (
        this.#sql
          .exec(
            `SELECT id FROM items WHERE id IN (SELECT value FROM json_each(?))
              AND turn IN (SELECT value FROM json_each(?))`,
            JSON.stringify(refs),
            JSON.stringify(path),
          )
          .toArray() as { id: string }[]
      ).map((r) => String(r.id)),
    );
    return topics.map((t) => ({ ...t, refs: t.refs.filter((r) => on.has(r)) }));
  }

  /** `live` rows in the order their ids were first written. */
  #ordered(rows: TopicRow[], live: TopicRow[]): TopicRow[] {
    const first = new Map<string, number>();
    for (const r of rows) if (!first.has(r.id)) first.set(r.id, Number(r.row));
    return [...live].sort(
      (a, b) => (first.get(a.id) ?? 0) - (first.get(b.id) ?? 0) || Number(a.row) - Number(b.row),
    );
  }

  /**
   * Writes the summarizer's topics of a range whose last item is in `throughTurn`, merged into
   * `current` (the topics it was given): an update naming a current topic supersedes it, its refs
   * added to the old ones; any other starts a new topic. Refs must be among `items` (the range's
   * leaf items). Returns the rows written.
   */
  merge(
    updates: readonly TopicUpdate[] | undefined,
    options: { throughTurn: string; current: readonly Topic[]; items: ReadonlySet<string> },
  ): Topic[] {
    const byId = new Map(options.current.map((t) => [t.id, t]));
    const written: Topic[] = [];
    const now = Date.now();
    for (const u of (updates ?? []).slice(0, MAX_TOPIC_UPDATES)) {
      const title = String(u.title ?? "")
        .trim()
        .slice(0, MAX_TOPIC_TITLE);
      const body = String(u.body ?? "")
        .trim()
        .slice(0, MAX_TOPIC_BODY);
      const refs = (u.refs ?? []).filter((r) => options.items.has(r));
      if (!title || !refs.length) continue;
      const old = u.id ? byId.get(u.id) : undefined;
      const topic: Topic = {
        id: old?.id ?? `tp-${crypto.randomUUID()}`,
        title,
        body,
        refs: [...new Set([...(old?.refs ?? []), ...refs])],
        through_turn: options.throughTurn,
        updated_at: now,
      };
      this.#sql.exec(
        "INSERT INTO topics (id, title, body, refs, through_turn, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        topic.id,
        topic.title,
        topic.body,
        JSON.stringify(topic.refs),
        topic.through_turn,
        topic.updated_at,
      );
      byId.set(topic.id, topic);
      written.push(topic);
    }
    return written;
  }
}
