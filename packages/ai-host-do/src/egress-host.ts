// The egress gateway's host side (statewalker/statewalker-root#208, decided in #161): how this
// runtime sends a request the gateway admitted, and how each runtime holds the address rule.
//
//   CellB on Node   `node:https` with the gateway's own `lookup`: the name is resolved by the
//                   gateway, every address admitted, and the connection made to the address
//                   admitted (pinned: DNS rebinding has no window). A request whose lookup never
//                   ran fails closed.
//   workerd/Workers, CellD, CellB in a browser
//                   `fetch` only: the gateway resolves the name (`node:dns` where the runtime has
//                   it, else DNS-over-HTTPS) and admits every address, then `fetch` connects,
//                   resolving again. That second resolution is a short rebinding window, stated in
//                   the threat table: on Workers the platform's network reaches no private or
//                   metadata address anyway; on CellD and in a browser the window stays.
//
// Literal addresses, the URL rules (https, default port, internal names) and redirects (followed
// by the gateway, never by `fetch`, each hop re-checked) are the same everywhere.
import {
  dohResolver,
  type EgressTransport,
  fetchTransport,
  nodeTransport,
  type Resolver,
} from "@statewalker/ai-environment";

/** Whether this runtime is CellB on Node (a Node realm hosting the deployment). */
export function onNode(): boolean {
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "";
  return /^Node\.js\//.test(ua);
}

/** The runtime's resolver: `node:dns` where it answers, else DNS-over-HTTPS. */
async function runtimeResolver(): Promise<Resolver> {
  const doh = dohResolver();
  try {
    const dns = (await import("node:dns")) as unknown as {
      promises?: { lookup(host: string, o: { all: true }): Promise<{ address: string }[]> };
    };
    const lookup = dns.promises?.lookup;
    if (typeof lookup !== "function") return doh;
    return async (host) => {
      try {
        const list = await lookup(host, { all: true });
        if (Array.isArray(list) && list.length) return list.map((a) => a.address);
      } catch (e) {
        // A runtime whose node:dns is a stub answers "not implemented": ask DNS-over-HTTPS.
        if (!/not implemented|ENOSYS|unsupported/i.test(String((e as Error)?.message ?? e)))
          throw e;
      }
      return doh(host);
    };
  } catch {
    return doh;
  }
}

let transport: Promise<EgressTransport> | undefined;

/** This runtime's egress transport (see the module comment), made once. */
export function egressTransport(): Promise<EgressTransport> {
  transport ??= (async () => {
    if (onNode()) {
      try {
        return await nodeTransport();
      } catch {
        // No node:https here after all: the fetch transport below.
      }
    }
    return fetchTransport(await runtimeResolver());
  })();
  return transport;
}
