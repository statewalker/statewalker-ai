// The egress gateway's core (statewalker/statewalker-root#208, decided in #161): the address rule,
// the URL rules, redirects re-checked hop by hop, caps, bound secrets put in only for their hosts.
import { describe, expect, it } from "vitest";
import {
  type EgressTransport,
  egressFetch,
  internalAddress,
  networkNeeds,
  parseEgress,
} from "../src/egress.js";
import type { ResolvedSecret } from "../src/secrets.js";

describe("internalAddress", () => {
  it("refuses loopback, RFC 1918, link-local, metadata and other non-public addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "127.8.9.10",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "fd00:ec2::254",
      "2002:7f00:1::",
    ])
      expect(internalAddress(ip), ip).toBe(true);
  });

  it("lets public addresses through", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::6810:84e5"])
      expect(internalAddress(ip), ip).toBe(false);
  });

  it("refuses what is not an address at all", () => {
    expect(internalAddress("not-an-ip")).toBe(true);
  });
});

describe("parseEgress", () => {
  it("has an empty allowlist and the decided caps by default", () => {
    const { config, problems } = parseEgress({});
    expect(problems).toEqual([]);
    expect(config.allow).toEqual([]);
    expect(config.maxResponseBytes).toBe(10 * 1024 * 1024);
    expect(config.maxBodyBytes).toBe(1024 * 1024);
    expect(config.maxQueryBytes).toBe(8 * 1024);
  });

  it("reads the allowlist and caps, reporting entries that are not host patterns", () => {
    const { config, problems } = parseEgress({
      EGRESS_ALLOW: "api.example.com, *.github.com/repos, https://x.y, bad host",
      EGRESS_MAX_RESPONSE_BYTES: "2048",
    });
    expect(config.allow).toEqual(["api.example.com", "*.github.com/repos"]);
    expect(config.maxResponseBytes).toBe(2048);
    expect(problems).toHaveLength(2);
  });
});

describe("networkNeeds", () => {
  it("reads requires.network declarations and reports malformed ones", () => {
    const { needs, problems } = networkNeeds({
      network: [
        { host: "API.example.com", path: "/v1" },
        { host: "*.github.com", write: true },
        { path: "/x" },
        "bad",
      ],
    });
    expect(needs).toEqual([
      { host: "api.example.com", path: "/v1" },
      { host: "*.github.com", write: true },
    ]);
    expect(problems).toHaveLength(2);
  });

  it("finds no declaration in a list of requirements", () => {
    expect(networkNeeds(["python"]).needs).toEqual([]);
  });
});

/** A transport answering from a table, recording each hop and the addresses it was given. */
function fakeTransport(
  answers: Record<string, () => Response>,
  addresses: Record<string, string[]>,
): EgressTransport & { hops: { url: string; headers: Record<string, string>; method: string }[] } {
  const hops: { url: string; headers: Record<string, string>; method: string }[] = [];
  return {
    hops,
    pinned: true,
    async fetch(url, init, admit) {
      const ips = addresses[url.hostname] ?? [url.hostname];
      for (const ip of ips) admit(ip);
      hops.push({ url: url.href, headers: { ...init.headers }, method: init.method });
      const answer = answers[url.href];
      if (!answer) return new Response("nothing here", { status: 404 });
      return answer();
    },
  };
}

const config = () => parseEgress({}).config;

describe("egressFetch", () => {
  it("sends an https request and answers its status, headers and body", async () => {
    const t = fakeTransport(
      { "https://api.example.com/v1/x": () => new Response("hello", { status: 200 }) },
      { "api.example.com": ["93.184.216.34"] },
    );
    const r = await egressFetch(
      { url: "https://api.example.com/v1/x" },
      { config: config(), transport: t },
    );
    expect(r.status).toBe(200);
    expect(new TextDecoder().decode(r.body)).toBe("hello");
    expect(r.hops).toBe(1);
  });

  it("allows https on the default port only", async () => {
    const t = fakeTransport({}, {});
    await expect(
      egressFetch({ url: "http://api.example.com/" }, { config: config(), transport: t }),
    ).rejects.toThrow(/EACCES: .*https/);
    await expect(
      egressFetch({ url: "https://api.example.com:8443/" }, { config: config(), transport: t }),
    ).rejects.toThrow(/EACCES: .*default port/);
    expect(t.hops).toHaveLength(0);
  });

  it("refuses a name that resolves to an internal address before connecting (DNS rebinding)", async () => {
    const t = fakeTransport(
      { "https://rebind.example/": () => new Response("inside") },
      { "rebind.example": ["93.184.216.34", "127.0.0.1"] },
    );
    await expect(
      egressFetch({ url: "https://rebind.example/" }, { config: config(), transport: t }),
    ).rejects.toThrow(/EACCES: .*internal address/);
    expect(t.hops).toHaveLength(0);
  });

  it("refuses internal and metadata address literals and names", async () => {
    const t = fakeTransport({}, {});
    for (const url of [
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/",
      "https://10.1.2.3/",
      "https://localhost/",
      "https://metadata.google.internal/",
      "https://2130706433/",
    ])
      await expect(egressFetch({ url }, { config: config(), transport: t }), url).rejects.toThrow(
        /EACCES/,
      );
    expect(t.hops).toHaveLength(0);
  });

  it("re-checks every redirect: an internal hop is refused", async () => {
    const t = fakeTransport(
      {
        "https://api.example.com/go": () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://api.example.com/next" },
          }),
        "https://api.example.com/next": () =>
          new Response(null, { status: 301, headers: { location: "https://169.254.169.254/" } }),
      },
      { "api.example.com": ["93.184.216.34"] },
    );
    await expect(
      egressFetch({ url: "https://api.example.com/go" }, { config: config(), transport: t }),
    ).rejects.toThrow(/EACCES: .*internal address/);
    expect(t.hops.map((h) => h.url)).toEqual([
      "https://api.example.com/go",
      "https://api.example.com/next",
    ]);
  });

  it("asks the caller to admit each hop, so another host is decided again", async () => {
    const t = fakeTransport(
      {
        "https://a.example/": () =>
          new Response(null, { status: 307, headers: { location: "https://b.example/x" } }),
      },
      { "a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"] },
    );
    const admitted: string[] = [];
    await expect(
      egressFetch(
        { url: "https://a.example/" },
        {
          config: config(),
          transport: t,
          admitHop: async (url) => {
            admitted.push(url.href);
            if (url.hostname === "b.example") throw new Error("EACCES: not granted");
          },
        },
      ),
    ).rejects.toThrow(/not granted/);
    expect(admitted).toEqual(["https://a.example/", "https://b.example/x"]);
  });

  it("caps the request body, the query string and the response", async () => {
    const small = { ...config(), maxBodyBytes: 4, maxQueryBytes: 8, maxResponseBytes: 5 };
    const t = fakeTransport(
      { "https://a.example/big": () => new Response("123456789") },
      { "a.example": ["93.184.216.34"] },
    );
    await expect(
      egressFetch(
        { url: "https://a.example/", method: "POST", body: "12345" },
        { config: small, transport: t },
      ),
    ).rejects.toThrow(/E2BIG: .*body/);
    await expect(
      egressFetch({ url: "https://a.example/?q=123456789" }, { config: small, transport: t }),
    ).rejects.toThrow(/E2BIG: .*query/);
    await expect(
      egressFetch({ url: "https://a.example/big" }, { config: small, transport: t }),
    ).rejects.toThrow(/E2BIG: .*response/);
  });

  it("puts bound secrets in only for their host, never follows them elsewhere, and redacts them", async () => {
    const secret: ResolvedSecret = {
      name: "API_KEY",
      value: "s3cr3t-value",
      level: "user",
      bindings: { plugins: ["code"], hosts: ["a.example"] },
    } as ResolvedSecret;
    const t = fakeTransport(
      {
        "https://a.example/echo": () =>
          new Response("you sent s3cr3t-value", { headers: { "x-echo": "s3cr3t-value" } }),
        "https://a.example/away": () =>
          new Response(null, { status: 302, headers: { location: "https://b.example/" } }),
      },
      { "a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"] },
    );
    const options = {
      config: config(),
      transport: t,
      secrets: {
        plugin: "code",
        lookup: async (n: string) => (n === "API_KEY" ? secret : undefined),
      },
    };
    const r = await egressFetch(
      { url: "https://a.example/echo", headers: { authorization: "Bearer {{secret:API_KEY}}" } },
      options,
    );
    expect(t.hops[0]?.headers.authorization).toBe("Bearer s3cr3t-value");
    expect(new TextDecoder().decode(r.body)).toBe("you sent [secret API_KEY]");
    expect(r.headers["x-echo"]).toBe("[secret API_KEY]");
    expect(r.secrets).toEqual(["API_KEY"]);
    await expect(
      egressFetch(
        { url: "https://a.example/away", headers: { authorization: "Bearer {{secret:API_KEY}}" } },
        options,
      ),
    ).rejects.toThrow(/EACCES: secret API_KEY is not bound/);
    expect(t.hops.map((h) => h.url)).toEqual(["https://a.example/echo", "https://a.example/away"]);
  });

  it("reaches a test deployment's internal hosts over http only when it lists them", async () => {
    const listed = { ...config(), internalHosts: ["127.0.0.1"] };
    const t = fakeTransport({ "http://127.0.0.1:8080/x": () => new Response("ok") }, {});
    const r = await egressFetch(
      { url: "http://127.0.0.1:8080/x" },
      { config: listed, transport: t },
    );
    expect(r.status).toBe(200);
    await expect(
      egressFetch({ url: "http://127.0.0.2:8080/x" }, { config: listed, transport: t }),
    ).rejects.toThrow(/EACCES/);
  });

  it("counts each hop before it is sent (the outbound meter), and refuses when the meter does", async () => {
    const t = fakeTransport(
      {
        "https://a.example/1": () =>
          new Response(null, { status: 302, headers: { location: "/2" } }),
        "https://a.example/2": () => new Response("done"),
      },
      { "a.example": ["93.184.216.34"] },
    );
    const charged: number[] = [];
    const r = await egressFetch(
      { url: "https://a.example/1", method: "POST", body: "abc" },
      { config: config(), transport: t, beforeHop: async (sent) => void charged.push(sent) },
    );
    expect(r.status).toBe(200);
    // A 302 after a POST goes on as a GET without the body.
    expect(t.hops.map((h) => h.method)).toEqual(["POST", "GET"]);
    expect(charged).toEqual([3, 0]);
  });
});

describe("nodeTransport", () => {
  it("connects only after the gateway's own lookup admitted the address: a name resolving inside is refused", async () => {
    const { nodeTransport } = await import("../src/egress.js");
    const asked: string[] = [];
    const transport = await nodeTransport(async (host) => {
      asked.push(host);
      return ["10.9.8.7"];
    });
    await expect(
      egressFetch({ url: "https://public.example/" }, { config: config(), transport }),
    ).rejects.toThrow(/EACCES: public.example resolves to an internal address \(10.9.8.7\)/);
    expect(asked).toEqual(["public.example"]);
  });

  it("sends to a test deployment's listed internal host, and reads the answer", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => res.end(`got ${req.method} ${req.url}`));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const { nodeTransport } = await import("../src/egress.js");
      const r = await egressFetch(
        { url: `http://127.0.0.1:${port}/x?y=1` },
        { config: { ...config(), internalHosts: ["127.0.0.1"] }, transport: await nodeTransport() },
      );
      expect(new TextDecoder().decode(r.body)).toBe("got GET /x?y=1");
    } finally {
      server.close();
    }
  });
});

describe("gatewayFetch with the egress address rule (REST tools, remote MCP servers)", () => {
  const lookup = async () => undefined;
  it("refuses internal and metadata addresses, names resolving inside, and plain http", async () => {
    const { gatewayFetch } = await import("../src/secrets.js");
    const t = fakeTransport(
      { "https://api.example.com/ok": () => new Response("fine") },
      { "api.example.com": ["93.184.216.34"], "inside.example": ["192.168.0.4"] },
    );
    const guard = { config: config(), transport: t };
    for (const url of [
      "https://169.254.169.254/latest/meta-data",
      "https://inside.example/",
      "http://api.example.com/ok",
      "https://localhost/",
    ]) {
      const r = await gatewayFetch({ url }, "rest", lookup, fetch, guard);
      expect(r.ok, url).toBe(false);
      expect(r.error, url).toMatch(/^EACCES/);
    }
    expect(t.hops).toHaveLength(0);
    const ok = await gatewayFetch(
      { url: "https://api.example.com/ok" },
      "rest",
      lookup,
      fetch,
      guard,
    );
    expect(ok).toMatchObject({ ok: true, status: 200, body: "fine" });
  });

  it("follows no redirect: the 3xx is the answer, and nothing is sent to where it points", async () => {
    const { gatewayFetch } = await import("../src/secrets.js");
    const t = fakeTransport(
      {
        "https://api.example.com/go": () =>
          new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }),
      },
      { "api.example.com": ["93.184.216.34"] },
    );
    const r = await gatewayFetch({ url: "https://api.example.com/go" }, "rest", lookup, fetch, {
      config: config(),
      transport: t,
    });
    expect(r.status).toBe(302);
    expect(t.hops.map((h) => h.url)).toEqual(["https://api.example.com/go"]);
  });
});

describe("egressFetch without following redirects", () => {
  it("answers the redirect itself when asked to, sending nothing to where it points", async () => {
    const t = fakeTransport(
      {
        "https://a.example/go": () =>
          new Response(null, { status: 302, headers: { location: "https://b.example/" } }),
      },
      { "a.example": ["93.184.216.34"] },
    );
    const r = await egressFetch(
      { url: "https://a.example/go", redirect: "manual" },
      { config: config(), transport: t },
    );
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("https://b.example/");
    expect(t.hops).toHaveLength(1);
  });
});
