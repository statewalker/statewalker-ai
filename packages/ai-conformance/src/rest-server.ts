// A fake REST server for scenarios where tools call out: it records every request it receives
// (method, URL, headers, body) and answers `/echo` with the request's headers, a path holding
// `nowhere` with 404, `/redirect?to=<url>[&status=<3xx>]` with a redirect, `/big?n=<bytes>` with that
// many bytes, anything else with `{"ok":true}`. `delayMs` holds each answer back, and
// `maxInFlight` records the most requests it held at once (reset it to measure).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface RestRequest {
  method: string;
  /** Path and query, as received. */
  url: string;
  headers: Record<string, string>;
  /** The request's body, when it had one. */
  body?: string;
}

export interface FakeRest {
  /** `http://127.0.0.1:<port>`; the same server answers on `localhost`. */
  url: string;
  port: number;
  requests: RestRequest[];
  /** How long each answer is held back (default 0). */
  delayMs: number;
  /** The most requests in progress at once since it was last set. */
  maxInFlight: number;
  close(): Promise<void>;
}

export async function fakeRest(): Promise<FakeRest> {
  let inFlight = 0;
  const state: FakeRest = {
    url: "",
    port: 0,
    requests: [],
    delayMs: 0,
    maxInFlight: 0,
    close: async () => {},
  };
  const server = createServer(async (req, res) => {
    inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, inFlight);
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
      let body = "";
      for await (const chunk of req) body += chunk;
      state.requests.push({
        method: String(req.method),
        url: String(req.url),
        headers,
        ...(body ? { body } : {}),
      });
      if (state.delayMs) await new Promise((ok) => setTimeout(ok, state.delayMs));
      const query = new URL(String(req.url), "http://x").searchParams;
      if (req.url?.startsWith("/redirect")) {
        res.writeHead(Number(query.get("status")) || 302, { location: String(query.get("to")) });
        res.end();
        return;
      }
      if (req.url?.includes("/big?")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(Number(query.get("n")) || 0));
        return;
      }
      const missing = req.url?.includes("nowhere");
      res.writeHead(missing ? 404 : 200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          missing
            ? { error: "no such thing" }
            : req.url?.startsWith("/echo")
              ? { headers }
              : { ok: true },
        ),
      );
    } finally {
      inFlight--;
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  state.port = port;
  state.close = () => new Promise<void>((ok) => server.close(() => ok()));
  return state;
}
