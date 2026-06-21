import { describe, expect, it, vi } from "vitest";
import { McpClientManager, type McpErrorHandler } from "../../src/mcp/mcp-client-manager.js";

/** Drive the manager against an unreachable URL to observe routed errors. */
async function settleConnect(
  manager: McpClientManager,
  servers: Record<string, { url: string; type?: "http" | "sse" }>,
) {
  // loadServers awaits doConnect — perfect for tests.
  await manager.loadServers(servers);
}

describe("McpClientManager.setErrorHandler", () => {
  it("default handler logs to console.warn with server context", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new McpClientManager();
    await settleConnect(manager, {
      bad: { url: "http://127.0.0.1:1/unreachable", type: "http" },
    });
    expect(warnSpy).toHaveBeenCalled();
    const args = warnSpy.mock.calls[0];
    if (!args) throw new Error("expected at least one warn call");
    expect(args[0]).toBe("[McpClientManager]");
    expect(args[1]).toBe("bad");
    expect(args[2]).toBeInstanceOf(Error);
    warnSpy.mockRestore();
  });

  it("custom handler receives error and { server } context on connect failure", async () => {
    const handler = vi.fn() satisfies McpErrorHandler;
    const manager = new McpClientManager().setErrorHandler(handler);
    await settleConnect(manager, {
      flaky: { url: "http://127.0.0.1:1/nope", type: "http" },
    });
    expect(handler).toHaveBeenCalled();
    const calls = handler.mock.calls;
    const failureCall = calls.find((c) => c[1]?.server === "flaky");
    expect(failureCall).toBeDefined();
    expect(failureCall?.[0]).toBeInstanceOf(Error);
  });

  it("setErrorHandler returns the manager for chaining", () => {
    const manager = new McpClientManager();
    const result = manager.setErrorHandler(() => {});
    expect(result).toBe(manager);
  });

  it("manager continues past per-server failures (serverCount reflects only connected)", async () => {
    const handler = vi.fn();
    const manager = new McpClientManager().setErrorHandler(handler);
    await settleConnect(manager, {
      bad1: { url: "http://127.0.0.1:1/no", type: "http" },
      bad2: { url: "http://127.0.0.1:2/no", type: "http" },
    });
    // No reachable mock is harder to set up here — but both fail and the
    // manager has zero connected servers; the handler saw both errors.
    expect(manager.serverCount).toBe(0);
    const namedCalls = handler.mock.calls.filter(
      (c) => c[1]?.server === "bad1" || c[1]?.server === "bad2",
    );
    expect(namedCalls.length).toBeGreaterThanOrEqual(2);
  });
});
