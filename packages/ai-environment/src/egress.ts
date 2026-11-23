// The egress gateway's core (statewalker/statewalker-root#208, decided in #161): how one request
// of executed code, or of a host-side tool, leaves the harness. The host (the Workspace DO) decides
// whether the request may go at all (the deployment allowlist, the user's `net.*` roles, the
// agent's or tool's `requires.network`, the mode); this module then sends it hop by hop:
//
//   - HTTPS only, on the default port (a test deployment may list internal hosts it reaches over
//     http: `internalHosts`, never set in production);
//   - the address rule: loopback, private (RFC 1918, CGNAT, ULA), link-local, metadata, multicast
//     and unspecified addresses are refused. The name is resolved by the gateway and every address
//     checked before connecting; where the transport connects to the address it checked
//     (`pinned`, Node), DNS rebinding has no window at all (see each transport below);
//   - every redirect is a new hop: the URL rules, the address rule, the caller's own decision
//     (`admitHop`: another host is decided again) and the secrets' host bindings are checked again;
//   - caps: request body, query string, response body (E2BIG);
//   - bound secrets: `{{secret:NAME}}` in a header or the URL is put in only where the secret's
//     binding names the plugin and the hop's host (./secrets.ts); every form of a used value is
//     redacted from the response's headers and body, so the code never sees it.
import { codedError, permits } from "@statewalker/ai-access";
import {
  type OutgoingRequest,
  type ResolvedSecret,
  redactSecrets,
  resolveSecrets,
  type SecretLookup,
} from "./secrets.js";

// ---- configuration ------------------------------------------------------------------------------

export interface EgressConfig {
  /** The deployment allowlist: host patterns `<host>[/<path-prefix>]`; empty means no network. */
  allow: string[];
  maxResponseBytes: number;
  maxBodyBytes: number;
  maxQueryBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  /**
   * Test-only: hosts a test deployment reaches over http, on any port, at internal addresses (its
   * local fake servers). Empty in production.
   */
  internalHosts: string[];
  /** Test-only: names resolved to these addresses before any resolver is asked. */
  hosts: Record<string, string[]>;
}

export interface EgressEnv {
  EGRESS_ALLOW?: string;
  EGRESS_MAX_RESPONSE_BYTES?: string;
  EGRESS_MAX_BODY_BYTES?: string;
  EGRESS_MAX_QUERY_BYTES?: string;
  EGRESS_TIMEOUT_MS?: string;
  EGRESS_INTERNAL_HOSTS?: string;
  EGRESS_TEST_HOSTS?: string;
}

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** A host pattern: exact (a DNS name or an IPv4 address) or `*.<domain>`, then a path prefix. */
const HOST_PATTERN = new RegExp(`^(?:\\*\\.)?${HOST_LABEL}(?:\\.${HOST_LABEL})*(?:/[^\\s?#]*)?$`);

const listOf = (value: unknown): string[] => {
  if (typeof value !== "string" || !value.trim()) return [];
  const text = value.trim();
  if (text.startsWith("[")) {
    try {
      const list = JSON.parse(text);
      return Array.isArray(list) ? list.map(String) : [];
    } catch {
      return [text];
    }
  }
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const positive = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** The deployment's egress configuration, from its vars; problems are reported, never widened. */
export function parseEgress(env: EgressEnv): { config: EgressConfig; problems: string[] } {
  const problems: string[] = [];
  const allow: string[] = [];
  for (const entry of listOf(env.EGRESS_ALLOW)) {
    const p = entry.toLowerCase();
    if (HOST_PATTERN.test(p)) allow.push(p);
    else problems.push(`EGRESS_ALLOW: '${entry}' is not a host pattern (<host>[/<path>])`);
  }
  let hosts: Record<string, string[]> = {};
  if (env.EGRESS_TEST_HOSTS) {
    try {
      const v = JSON.parse(env.EGRESS_TEST_HOSTS);
      if (v && typeof v === "object" && !Array.isArray(v))
        hosts = Object.fromEntries(
          Object.entries(v).map(([k, a]) => [
            k.toLowerCase(),
            (Array.isArray(a) ? a : [a]).map(String),
          ]),
        );
    } catch {
      problems.push("EGRESS_TEST_HOSTS is a JSON object {name: [address]}");
    }
  }
  return {
    config: {
      allow,
      maxResponseBytes: positive(env.EGRESS_MAX_RESPONSE_BYTES, 10 * 1024 * 1024),
      maxBodyBytes: positive(env.EGRESS_MAX_BODY_BYTES, 1024 * 1024),
      maxQueryBytes: positive(env.EGRESS_MAX_QUERY_BYTES, 8 * 1024),
      maxRedirects: 5,
      timeoutMs: positive(env.EGRESS_TIMEOUT_MS, 30_000),
      internalHosts: listOf(env.EGRESS_INTERNAL_HOSTS).map((h) => h.toLowerCase()),
      hosts,
    },
    problems,
  };
}

/** One host an agent or a tool declares it needs (`requires.network`): a request, not a grant. */
export interface NetworkNeed {
  host: string;
  path?: string;
  write?: boolean;
}

/** The `network` entries of a `requires` declaration (an object's `network` key). */
export function networkNeeds(requires: unknown): { needs: NetworkNeed[]; problems: string[] } {
  const needs: NetworkNeed[] = [];
  const problems: string[] = [];
  const list =
    requires && typeof requires === "object" && !Array.isArray(requires)
      ? (requires as { network?: unknown }).network
      : undefined;
  if (list === undefined || list === null) return { needs, problems };
  if (!Array.isArray(list)) return { needs, problems: ["requires.network is a list"] };
  for (const entry of list) {
    const e = entry as { host?: unknown; path?: unknown; write?: unknown };
    const host = typeof e?.host === "string" ? e.host.toLowerCase() : "";
    const path = typeof e?.path === "string" ? e.path : undefined;
    if (!host || !HOST_PATTERN.test(host + (path ?? "")) || (path && !path.startsWith("/"))) {
      problems.push(`requires.network: ${JSON.stringify(entry)} is not {host, path?, write?}`);
      continue;
    }
    needs.push({ host, ...(path ? { path } : {}), ...(e.write === true ? { write: true } : {}) });
  }
  return { needs, problems };
}

/** Whether a host pattern (`<host>[/<path>]`) covers a request's host and path. */
export function hostPatternCovers(pattern: string, host: string, path: string): boolean {
  return permits([{ area: "net", action: "read", target: pattern }], {
    area: "net",
    action: "read",
    target: `${host}${path || "/"}`,
  });
}

/** Whether a declaration covers a request: its host and path, and writes only where it says so. */
export function needsCover(
  needs: readonly NetworkNeed[],
  host: string,
  path: string,
  write: boolean,
): boolean {
  return needs.some(
    (n) =>
      (!write || n.write === true) && hostPatternCovers(`${n.host}${n.path ?? ""}`, host, path),
  );
}

/** The methods of `net.read` (the rest are `net.write`). */
export const READ_METHODS: readonly string[] = ["GET", "HEAD"];
export const isWriteMethod = (method: string) => !READ_METHODS.includes(method.toUpperCase());

// ---- the address rule -----------------------------------------------------------------------------

const v4Parts = (ip: string): number[] | undefined => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : undefined;
};

function internalV4([a = 0, b = 0, c = 0]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** An IPv6 address as eight 16-bit groups, or undefined. */
function v6Groups(ip: string): number[] | undefined {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(text)) return undefined;
  // A trailing dotted IPv4 part is two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = v4Parts(tail);
    if (!v4) return undefined;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] ?? 0) * 256 + (v4[1] ?? 0)).toString(16)}:${((v4[2] ?? 0) * 256 + (v4[3] ?? 0)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (s: string) => (s ? s.split(":") : []);
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.map((g) => Number.parseInt(g, 16));
}

const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/**
 * Whether an address is one the gateway never connects to: loopback, private, link-local, cloud
 * metadata, multicast, unspecified or reserved, IPv4 or IPv6 (IPv4-mapped, NAT64 and 6to4 forms are
 * judged by the IPv4 address they carry). Anything that is not an address counts as internal.
 */
export function internalAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "");
  const v4 = v4Parts(ip);
  if (v4) return internalV4(v4);
  const g = v6Groups(ip);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::, ::1, IPv4-compatible and IPv4-mapped (::ffff:a.b.c.d)
    if (g5 === 0xffff || g5 === 0) {
      if (g5 === 0 && g6 === 0) return true;
      return internalV4(embeddedV4(g6, g7));
    }
  }
  if (g0 === 0x64 && g1 === 0xff9b) return internalV4(embeddedV4(g6, g7)); // NAT64
  if (g0 === 0x2002) return internalV4(embeddedV4(g1, g2)); // 6to4
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local (fc00::/7), AWS metadata fd00:ec2::254
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) // discard-only
  );
}

/** Names that stand for the machine itself or its cloud's metadata service, whatever DNS says. */
export function internalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    h === "metadata" ||
    h === "instance-data" ||
    h === "metadata.google.internal"
  );
}

const isAddress = (host: string) => !!v4Parts(host) || !!v6Groups(host.replace(/^\[|\]$/g, ""));

// ---- transports -----------------------------------------------------------------------------------

/** One hop, as a transport sends it. */
export interface HopInit {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal;
}

/**
 * How one hop is sent. `admit(address)` throws for an address the gateway refuses: the transport
 * calls it on every address it would connect to, before connecting.
 */
export interface EgressTransport {
  /**
   * Whether the connection goes to the very address that was admitted (Node: the resolver is the
   * gateway's, so DNS rebinding has no window). Otherwise the name was resolved and admitted just
   * before the runtime's own fetch resolved it again.
   */
  readonly pinned: boolean;
  fetch(url: URL, init: HopInit, admit: (address: string) => void): Promise<Response>;
}

/** Resolves a name to its addresses (IPv4 and IPv6). */
export type Resolver = (host: string) => Promise<string[]>;

/** A resolver over DNS-over-HTTPS (JSON API), for runtimes with no resolver of their own. */
export function dohResolver(
  fetcher: typeof fetch = fetch,
  endpoint = "https://cloudflare-dns.com/dns-query",
): Resolver {
  return async (host) => {
    const out: string[] = [];
    for (const type of ["A", "AAAA"]) {
      const res = await fetcher(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
      });
      if (!res.ok) throw codedError("EIO", `cannot resolve ${host}: DNS answered ${res.status}`);
      const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
      for (const a of body.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
    }
    if (!out.length) throw codedError("ENOENT", `${host} has no address`);
    return out;
  };
}

/**
 * The transport of runtimes that only have `fetch` (workerd and Workers, CellD, CellB in a
 * browser): the gateway resolves the name itself and admits every address, then `fetch` connects
 * (resolving again: a short rebinding window, stated in the threat table). Redirects are never
 * followed by `fetch` itself.
 */
export function fetchTransport(resolver: Resolver, fetcher: typeof fetch = fetch): EgressTransport {
  return {
    pinned: false,
    async fetch(url, init, admit) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      for (const address of isAddress(host) ? [host] : await resolver(host)) admit(address);
      return fetcher(url.href, {
        method: init.method,
        headers: init.headers,
        ...(init.body ? { body: init.body as unknown as NonNullable<RequestInit["body"]> } : {}),
        redirect: "manual",
        ...(init.signal ? { signal: init.signal } : {}),
      });
    },
  };
}

type NodeLookup = (
  host: string,
  options: unknown,
  cb: (err: Error | null, address?: unknown, family?: number) => void,
) => void;

/**
 * The transport of Node (CellB on Node): `node:https` with the gateway's own `lookup`, which
 * resolves the name, admits every address and hands the connection the address it admitted, so the
 * connection goes where the check said (no rebinding window). A request whose lookup never ran
 * (a runtime whose `node:https` ignores it) fails closed.
 */
export async function nodeTransport(resolver?: Resolver): Promise<EgressTransport> {
  const https = (await import("node:https")) as unknown as {
    request(
      url: URL,
      options: Record<string, unknown>,
      cb: (res: unknown) => void,
    ): {
      on(e: string, f: (x: unknown) => void): void;
      end(body?: Uint8Array): void;
      destroy(e?: Error): void;
    };
  };
  const http = (await import("node:http")) as unknown as typeof https;
  const dns = (await import("node:dns")) as unknown as { lookup: NodeLookup };
  const { Readable } = (await import("node:stream")) as unknown as {
    Readable: { toWeb(r: unknown): ReadableStream<Uint8Array> };
  };
  const resolve: Resolver =
    resolver ??
    ((host) =>
      new Promise((ok, fail) =>
        dns.lookup(host, { all: true, verbatim: true }, (err, list) =>
          err ? fail(err) : ok((list as { address: string }[]).map((a) => a.address)),
        ),
      ));
  return {
    pinned: true,
    fetch(url, init, admit) {
      return new Promise<Response>((done, fail) => {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        let looked = isAddress(host);
        if (looked) {
          try {
            admit(host);
          } catch (e) {
            fail(e);
            return;
          }
        }
        const lookup: NodeLookup = (name, options, cb) => {
          looked = true;
          resolve(name).then(
            (addresses) => {
              try {
                for (const a of addresses) admit(a);
              } catch (e) {
                cb(e as Error);
                return;
              }
              const first = addresses[0] as string;
              const family = first.includes(":") ? 6 : 4;
              if ((options as { all?: boolean })?.all) cb(null, [{ address: first, family }]);
              else cb(null, first, family);
            },
            (e) => cb(e as Error),
          );
        };
        const lib = url.protocol === "http:" ? http : https;
        const req = lib.request(
          url,
          {
            method: init.method,
            headers: init.headers,
            lookup,
            // No kept-alive socket is reused: every request runs the gateway's own lookup.
            agent: false,
            ...(init.signal ? { signal: init.signal } : {}),
          },
          (raw) => {
            const res = raw as {
              statusCode: number;
              headers: Record<string, string | string[] | undefined>;
              resume(): void;
            };
            if (!looked) {
              res.resume();
              fail(codedError("EACCES", "this runtime did not let the gateway resolve the name"));
              return;
            }
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers))
              for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v])
                headers.append(k, x);
            const empty = [101, 204, 205, 304].includes(res.statusCode) || init.method === "HEAD";
            if (empty) res.resume();
            done(
              new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers }),
            );
          },
        );
        req.on("error", (e) => fail(e));
        req.end(init.body);
      });
    },
  };
}

// ---- sending --------------------------------------------------------------------------------------

/** What a request through the gateway answers. Secret values are redacted from all of it. */
export interface EgressResponse {
  status: number;
  /** The final URL (after redirects). */
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  /** The bytes the request sent, over every hop. */
  sent: number;
  hops: number;
  /** The secret names used, never their values. */
  secrets: string[];
}

export interface EgressOptions {
  config: EgressConfig;
  transport: EgressTransport;
  /** Decides each hop beside the gateway's own rules (capability, roles, mode); throws to refuse. */
  admitHop?: (url: URL, method: string, hop: number) => Promise<void>;
  /** Called before each hop is sent with the bytes it sends (the outbound meter); throws to refuse. */
  beforeHop?: (sent: number, url: URL) => Promise<void>;
  /** Bound secrets: the plugin the request is made for, and where secrets are found. */
  secrets?: { plugin: string; lookup: SecretLookup };
  signal?: AbortSignal;
}

/** Headers code may not set: the gateway's own. */
const DROPPED = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
]);

/** The URL rules a hop must meet, before anything is resolved. */
export function checkEgressUrl(url: URL, config: EgressConfig): void {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const listed = config.internalHosts.includes(host);
  if (url.protocol !== "https:" && !(listed && url.protocol === "http:"))
    throw codedError("EACCES", `the egress gateway sends https requests only, not ${url.protocol}`);
  if (url.port && !listed)
    throw codedError(
      "EACCES",
      `the egress gateway sends to the default port only, not ${url.port}`,
    );
  if (url.username || url.password)
    throw codedError("EACCES", "a URL carries no user info: put credentials in secrets");
  if (!listed && internalName(host)) throw codedError("EACCES", `${host} is an internal address`);
  const query = new TextEncoder().encode(url.search).length;
  if (query > config.maxQueryBytes)
    throw codedError(
      "E2BIG",
      `the query string is ${query} bytes, over the cap of ${config.maxQueryBytes}`,
    );
}

/** A request through the gateway: an outgoing request whose body may be bytes. */
export type EgressRequest = Omit<OutgoingRequest, "body"> & {
  body?: string | Uint8Array;
  /** "manual": a redirect is the answer, not followed (the default follows, each hop re-checked). */
  redirect?: "follow" | "manual";
};

/** Bytes as a string of one character per byte. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return text;
}

/** Redacts used secrets from bytes, in every form `redactSecrets` knows, byte for byte. */
function redactBytes(bytes: Uint8Array, used: readonly ResolvedSecret[]): Uint8Array {
  if (!used.length) return bytes;
  // Latin-1 keeps every byte as one character; each secret form is matched as its UTF-8 bytes.
  const text = latin1(bytes);
  const asLatin1 = (s: string) => String.fromCharCode(...new TextEncoder().encode(s));
  const latin = used.map((s) => ({ ...s, value: asLatin1(s.value) }));
  const out = redactSecrets(text, latin);
  if (out === text) return bytes;
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 255);
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw codedError("E2BIG", `the response is larger than the cap of ${max} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Sends one request through the gateway, hop by hop (see the module comment). Throws a coded error
 * (`EACCES`, `E2BIG`, `EIO`, ...) for a request it refuses or that fails; secret values never
 * appear in what it answers or throws.
 */
export async function egressFetch(
  request: EgressRequest,
  options: EgressOptions,
): Promise<EgressResponse> {
  const { config } = options;
  // Every hop of the request shares one deadline (EGRESS_TIMEOUT_MS, 30 s by default).
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let method = String(request.method ?? "GET").toUpperCase();
  let body =
    request.body === undefined
      ? undefined
      : typeof request.body === "string"
        ? new TextEncoder().encode(request.body)
        : new Uint8Array(request.body);
  // What the secrets check reads of the body (a placeholder there is refused, never resolved).
  const bodyText = body ? latin1(body) : undefined;
  if (body && body.length > config.maxBodyBytes)
    throw codedError(
      "E2BIG",
      `the request body is ${body.length} bytes, over the cap of ${config.maxBodyBytes}`,
    );
  const templates: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers ?? {}))
    if (!DROPPED.has(k.toLowerCase())) templates[k.toLowerCase()] = String(v);
  let target = String(request.url);
  let sent = 0;
  let used: ResolvedSecret[] = [];
  const names = new Set<string>();
  const fail = (e: unknown): never => {
    const message = redactSecrets(String((e as Error)?.message ?? e), used);
    if (/^[A-Z][A-Z0-9]+: /.test(message)) throw new Error(message);
    throw codedError("EIO", `the request failed: ${message}`);
  };
  for (let hop = 0; ; hop++) {
    if (hop > config.maxRedirects)
      throw codedError("EIO", `more than ${config.maxRedirects} redirects`);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw codedError("EINVAL", "the request's URL is not absolute");
    }
    // The first hop's placeholders are read from the URL as written: a parsed URL percent-encodes
    // `{` and `}` in its path, where a placeholder would no longer be found.
    const written = hop === 0 ? target : url.href;
    // Placeholders are resolved for this hop's host (a secret never follows a redirect elsewhere).
    let headers = { ...templates };
    if (options.secrets) {
      const resolved = await resolveSecrets(
        { url: written, headers, ...(body && bodyText !== undefined ? { body: bodyText } : {}) },
        options.secrets.plugin,
        options.secrets.lookup,
      );
      for (const n of resolved.names) names.add(n);
      if (!resolved.ok) throw new Error(resolved.error);
      used = [...used, ...resolved.used.filter((s) => !used.some((u) => u.name === s.name))];
      url = new URL(resolved.url);
      headers = resolved.headers;
    }
    checkEgressUrl(url, config);
    await options.admitHop?.(url, method, hop);
    await options.beforeHop?.(body?.length ?? 0, url);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const listed = config.internalHosts.includes(host);
    const pinnedHosts = config.hosts[host];
    const admit = (address: string) => {
      if (listed) return;
      if (internalAddress(address))
        throw codedError("EACCES", `${host} resolves to an internal address (${address})`);
    };
    const transport: EgressTransport = pinnedHosts
      ? {
          pinned: true,
          fetch: (u, init, a) => {
            for (const address of pinnedHosts) a(address);
            return options.transport.fetch(u, init, a);
          },
        }
      : options.transport;
    let res: Response;
    try {
      res = await transport.fetch(
        url,
        {
          method,
          headers,
          ...(body ? { body } : {}),
          signal,
        },
        admit,
      );
    } catch (e) {
      return fail(e);
    }
    sent += body?.length ?? 0;
    // A browser's fetch answers a redirect it was told not to follow as an opaque response: the
    // gateway cannot see where it points, so it is neither followed nor handed on.
    if ((res.type as string) === "opaqueredirect")
      throw codedError("EACCES", "this runtime hides redirects from the gateway: none is followed");
    const location = res.headers.get("location");
    if (REDIRECTS.has(res.status) && location && request.redirect !== "manual") {
      await res.body?.cancel().catch(() => {});
      target = new URL(location, url).href;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = undefined;
        delete templates["content-type"];
      }
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(res, config.maxResponseBytes);
    } catch (e) {
      return fail(e);
    }
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k] = redactSecrets(v, used);
    });
    return {
      status: res.status,
      url: redactSecrets(url.href, used),
      headers: outHeaders,
      body: redactBytes(bytes, used),
      sent,
      hops: hop + 1,
      secrets: [...names],
    };
  }
}
