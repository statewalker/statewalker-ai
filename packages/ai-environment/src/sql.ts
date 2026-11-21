/** What the environment's tables need of SQLite: Durable Objects' `SqlStorage` has this shape. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}
