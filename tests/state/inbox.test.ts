import { describe, expect, it, vi } from "vitest";
import { Inbox } from "../../src/state/inbox.js";

describe("Inbox", () => {
  it("push enqueues and increments pending", () => {
    const inbox = new Inbox();
    expect(inbox.pending).toBe(0);
    inbox.push({ role: "user", text: "hello" });
    expect(inbox.pending).toBe(1);
    inbox.push({ role: "agent", text: "world" });
    expect(inbox.pending).toBe(2);
  });

  it("take returns messages in FIFO order", async () => {
    const inbox = new Inbox();
    inbox.push({ role: "user", text: "first" });
    inbox.push({ role: "user", text: "second" });

    const m1 = await inbox.take();
    expect(m1?.text).toBe("first");
    expect(inbox.pending).toBe(1);

    const m2 = await inbox.take();
    expect(m2?.text).toBe("second");
    expect(inbox.pending).toBe(0);
  });

  it("take suspends on empty queue until push", async () => {
    const inbox = new Inbox();
    let resolved = false;

    const promise = inbox.take().then((msg) => {
      resolved = true;
      return msg;
    });

    // Not resolved yet
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    inbox.push({ role: "user", text: "delayed" });
    const msg = await promise;
    expect(resolved).toBe(true);
    expect(msg?.text).toBe("delayed");
  });

  it("take returns undefined when aborted", async () => {
    const inbox = new Inbox();
    const abort = new AbortController();
    abort.abort();

    const msg = await inbox.take(abort.signal);
    expect(msg).toBeUndefined();
  });

  it("take returns undefined when abort fires while waiting", async () => {
    const inbox = new Inbox();
    const abort = new AbortController();

    const promise = inbox.take(abort.signal);
    setTimeout(() => abort.abort(), 10);

    const msg = await promise;
    expect(msg).toBeUndefined();
  });

  it("notifies on push", () => {
    const inbox = new Inbox();
    const listener = vi.fn();
    inbox.onUpdate(listener);

    inbox.push({ role: "user", text: "test" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies on take", async () => {
    const inbox = new Inbox();
    inbox.push({ role: "user", text: "test" });

    const listener = vi.fn();
    inbox.onUpdate(listener);

    await inbox.take();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("preserves source field", async () => {
    const inbox = new Inbox();
    inbox.push({ role: "agent", text: "msg", source: "agent-1" });

    const msg = await inbox.take();
    expect(msg?.source).toBe("agent-1");
  });
});
