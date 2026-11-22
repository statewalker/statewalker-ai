// A task's stream (Streaming, UHP 2026-10-19): the Responses event subset of the OpenAI
// projection's encoder (statewalker/statewalker-root#108), numbered from 0 with no gaps, as the
// session's log grows: `response.created`, `response.in_progress` once the turn starts, each
// output item as `output_item.added` … `output_item.done` as it is logged, then exactly one
// terminal event carrying the whole response: `response.completed`, `response.incomplete` (a
// question, a budget, an interruption) or `response.failed` (also for a cancelled turn, whose
// `status` says so). An idle frame stands for time with nothing new (a keep-alive comment). The
// stream follows the log, so a client going away stops nothing.

import { EventEncoder, isTerminal } from "@statewalker/ai-openai-compat";
import type { Item } from "@statewalker/ai-sessions";
import { type CreatedTask, callLookup, outputOf, responseOf, type UhpApi } from "./responses.js";

export async function* taskEvents(
  api: UhpApi,
  task: CreatedTask,
  options: { keepAliveMs: number },
): AsyncGenerator<Record<string, unknown> | { idle: true }> {
  const { session, turn } = task;
  const encoder = new EventEncoder();
  const callOf = callLookup(api, session.id);
  const emitted = new Set<string>();
  const items = (item: Record<string, unknown>) => {
    emitted.add(String(item.id));
    return encoder.itemEvents(item as never);
  };
  const initial = await responseOf(api, session, await api.getTurn(turn), task.context);
  yield encoder.event("response.created", {
    response: { ...initial, status: "in_progress", output: [] },
  });
  let started = false;
  let since = task.since;
  let upToDate = false;
  let ended = false;
  while (!ended) {
    const page = await api.readEvents(session.id, {
      since,
      limit: 1000,
      wait: upToDate ? options.keepAliveMs : 0,
    });
    if (!page.events.length && upToDate) yield { idle: true };
    for (const logged of page.events) {
      since = logged.seq;
      if (logged.turn !== turn) continue;
      if (logged.type === "turn.started" && !started) {
        started = true;
        yield encoder.event("response.in_progress", {
          response: { ...initial, status: "in_progress", output: [] },
        });
      } else if (logged.type === "item.created") {
        for (const item of await outputOf(logged.data as Item, callOf)) yield* items(item);
      } else if (logged.type.startsWith("turn.") && isTerminal(logged.type.slice(5))) {
        ended = true;
        break;
      }
    }
    upToDate = page.up_to_date;
    // A turn that ended before the cursor has nothing more to show.
    if (upToDate && !ended && isTerminal((await api.getTurn(turn)).status)) {
      const rest = await api.readEvents(session.id, { since, limit: 1000 });
      if (!rest.events.some((e) => e.turn === turn)) ended = true;
    }
  }
  const final = await responseOf(api, session, await api.getTurn(turn), task.context);
  // What the log holds no event of (the question a turn ends on) comes before the end.
  for (const item of final.output as Record<string, unknown>[])
    if (!emitted.has(String(item.id))) yield* items(item);
  const type =
    final.status === "completed"
      ? "response.completed"
      : final.status === "incomplete"
        ? "response.incomplete"
        : "response.failed";
  yield encoder.event(type, { response: final });
}
