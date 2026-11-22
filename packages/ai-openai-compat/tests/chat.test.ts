// A streamed Chat Completion reads the turn's events as the log grows. The turn can end between a
// page that was up to date and the status read after it: its last events are then still to be
// read, and the stream must show them (statewalker/statewalker-root#141 saw an empty answer).
import { describe, expect, it } from "vitest";
import { chatChunks } from "../src/chat.js";
import type { OpenAiApi } from "../src/responses.js";

const TURN = "s1.tu-1";
const turnView = (status: string) =>
  ({
    id: TURN,
    session_id: "s1",
    status,
    created: 1_000,
    model: "scripted/default",
    stop_reason: { type: "end_turn" },
    items: [],
  }) as never;

describe("a streamed Chat Completion", () => {
  it("shows the events a turn logged between an up-to-date page and its end", async () => {
    let reads = 0;
    let status = "running";
    const api = {
      getTurn: async () => turnView(status),
      readEvents: async () => {
        reads++;
        if (reads === 1) {
          // Up to date, nothing yet; the turn ends right after this page.
          status = "completed";
          return { events: [], offset: 1, up_to_date: true };
        }
        return {
          events: [
            {
              seq: 2,
              turn: TURN,
              type: "item.created",
              data: { kind: "message", role: "assistant", text: "OK" },
            },
            { seq: 3, turn: TURN, type: "turn.completed", data: {} },
          ],
          offset: 3,
          up_to_date: true,
        };
      },
      archiveSession: async () => ({}),
    } as unknown as OpenAiApi;
    let text = "";
    for await (const chunk of chatChunks(
      api,
      { session: "s1", turn: TURN, since: 0 },
      { keepAliveMs: 10, includeUsage: false },
    )) {
      const delta = (chunk as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta;
      text += delta?.content ?? "";
    }
    expect(text).toBe("OK");
  });
});
