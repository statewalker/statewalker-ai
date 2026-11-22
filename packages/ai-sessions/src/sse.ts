// The session's event log as Server-Sent Events (statewalker/statewalker-root#83, #108): a cursor
// read of the durable log from `since` (or `Last-Event-ID`), each event with its number as `id`;
// an `up-to-date` marker once the backlog is sent; a keep-alive comment whenever nothing happened
// for 30 s. A reader going away only stops the reading: nothing it watched is cancelled.
//
// Every stream ends with a terminal event: with `turn`, the turn's terminal event (carrying the
// full turn); without, the session's `session.archived`; and `error` when the stream can't go on
// (the token expired, the session was purged).
import { codeOf, statusOf } from "@statewalker/ai-access";
import { type SessionApi, type SessionEvent, TERMINAL_TURN_STATUSES } from "./api.js";

export const DEFAULT_KEEP_ALIVE_MS = 30_000;
const PAGE = 1000;

const TERMINAL_EVENTS = TERMINAL_TURN_STATUSES.map((s) => `turn.${s}`);

const frame = (event: SessionEvent) =>
  `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;

const marker = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * The SSE response for one session's events. The first read happens before the response, so a
 * refused token or an unknown session answers as an ordinary error.
 */
export async function eventStream(
  api: SessionApi,
  sessionId: string,
  options: { since?: number; turn?: string; keepAliveMs?: number },
): Promise<Response> {
  const keepAliveMs = options.keepAliveMs || DEFAULT_KEEP_ALIVE_MS;
  const turn = options.turn;
  let since = Number.isFinite(options.since) ? Number(options.since) : 0;
  if (turn) await api.getTurn(turn);
  const first = await api.readEvents(sessionId, { since, limit: PAGE });
  // The stream counts against the caller's limits on streams while it is open (#179).
  const held = await api.holdStream();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    void api.releaseStream(held).catch(() => {});
  };
  const encoder = new TextEncoder();
  let stopped = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        if (!stopped) controller.enqueue(encoder.encode(text));
      };
      const end = () => {
        release();
        if (stopped) return;
        stopped = true;
        controller.close();
      };
      /** Writes a page; true when it held the stream's terminal event. */
      const send = (events: SessionEvent[]) => {
        for (const event of events) {
          write(frame(event));
          since = event.seq;
          if (turn ? event.turn === turn && TERMINAL_EVENTS.includes(event.type) : false)
            return true;
          if (!turn && event.type === "session.archived") return true;
        }
        return false;
      };
      try {
        let page = first;
        let caughtUp = false;
        for (;;) {
          if (send(page.events)) return end();
          if (page.up_to_date && !caughtUp) {
            caughtUp = true;
            write(marker("up-to-date", { offset: since }));
            // A turn that ended before `since` still ends its stream with its terminal event.
            if (turn) {
              const view = await api.getTurn(turn);
              if ((TERMINAL_TURN_STATUSES as string[]).includes(view.status)) {
                // It may have ended just now: its terminal event is then in the log.
                const rest = await api.readEvents(sessionId, { since, limit: PAGE });
                if (send(rest.events)) return end();
                write(marker(`turn.${view.status}`, view));
                return end();
              }
            } else {
              // A session archived before `since` still ends its stream with the archive event.
              const session = await api.getSession(sessionId);
              if (session.archived) {
                const rest = await api.readEvents(sessionId, { since, limit: PAGE });
                if (send(rest.events)) return end();
                write(marker("session.archived", { id: session.id }));
                return end();
              }
            }
          }
          if (stopped) return;
          // Each read goes through the caller's User DO, which checks the token again.
          page = await api.readHeldEvents(sessionId, {
            since,
            limit: PAGE,
            wait: page.up_to_date ? keepAliveMs : 0,
          });
          if (!page.events.length) write(": keep-alive\n\n");
        }
      } catch (e) {
        write(
          marker("error", {
            error: String((e as Error)?.message ?? e),
            code: codeOf(e),
            status: statusOf(e),
          }),
        );
        end();
      }
    },
    cancel() {
      stopped = true;
      release();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}
