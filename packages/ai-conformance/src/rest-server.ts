// A fake REST server for scenarios where tools call out: it records every request it receives
// (method, URL, headers) and answers `/echo` with the request's headers, anything else with
// `{"ok":true}`.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface RestRequest {
  method: string;
  /** Path and query, as received. */
  url: string;
  headers: Record<string, string>;
}

export interface FakeRest {
  /** `http://127.0.0.1:<port>`; the same server answers on `localhost`. */
  url: string;
  port: number;
  requests: RestRequest[];
  close(): Promise<void>;
}

export async function fakeRest(): Promise<FakeRest> {
  const requests: RestRequest[] = [];
  const server = createServer((req, res) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
    requests.push({ method: String(req.method), url: String(req.url), headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url?.startsWith("/echo") ? { headers } : { ok: true }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
