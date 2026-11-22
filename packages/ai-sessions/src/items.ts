// A row of an agent session's `items` table: the session's flat, append-only log.
import type { Item, ItemInput } from "./api.js";

export interface ItemRow {
  seq: number;
  id: string;
  turn: string;
  kind: string;
  body: string;
}

export const itemOf = (row: ItemRow): Item => ({
  ...(JSON.parse(row.body) as Omit<ItemInput, "kind">),
  seq: Number(row.seq),
  id: row.id,
  turn: row.turn,
  kind: row.kind as Item["kind"],
});
