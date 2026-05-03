import { describe, expect, it } from "vitest";
import { deserialize } from "../../../src/state/serialization/deserialize.js";
import { type Node, serialize } from "../../../src/state/serialization/serialize.js";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

async function roundTrip(nodes: Node[]): Promise<Node[]> {
  const md = (await collect(serialize(nodes))).join("");
  return collect(deserialize([md]));
}

describe("stream serializer", () => {
  it("empty input produces empty output", async () => {
    const out = await collect(serialize([]));
    expect(out).toEqual([]);
    const back = await collect(deserialize([""]));
    expect(back).toEqual([]);
  });

  it("single node with no props and no content round-trips", async () => {
    const nodes: Node[] = [{ props: {}, content: "" }];
    expect(await roundTrip(nodes)).toEqual(nodes);
  });

  it("single node with props and content round-trips", async () => {
    const nodes: Node[] = [{ props: { id: "n1", type: "user" }, content: "hello\nworld" }];
    expect(await roundTrip(nodes)).toEqual(nodes);
  });

  it("multi-node sequence round-trips in order", async () => {
    const nodes: Node[] = [
      { props: { id: "a" }, content: "one" },
      { props: { id: "b", parentId: "a" }, content: "two" },
      { props: { id: "c", parentId: "a" }, content: "three" },
    ];
    expect(await roundTrip(nodes)).toEqual(nodes);
  });

  it("props with `=` in value round-trip", async () => {
    const nodes: Node[] = [{ props: { url: "a=b=c", id: "n1" }, content: "" }];
    expect(await roundTrip(nodes)).toEqual(nodes);
  });

  it("props with newline in value round-trip", async () => {
    const nodes: Node[] = [{ props: { ml: "line1\nline2\nline3", id: "n1" }, content: "" }];
    expect(await roundTrip(nodes)).toEqual(nodes);
  });

  it("content containing `---` line is escaped on serialize and unescaped on deserialize", async () => {
    const nodes: Node[] = [{ props: { id: "n1" }, content: "before\n---\nafter" }];
    const md = (await collect(serialize(nodes))).join("");
    expect(md).toContain("\\---");
    expect(await roundTrip(nodes)).toEqual(nodes);
  });

  it("content with multiple blank lines preserves them after the first (props end after first blank)", async () => {
    const nodes: Node[] = [{ props: { id: "n1" }, content: "para1\n\npara2\n\npara3" }];
    expect(await roundTrip(nodes)).toEqual(nodes);
  });

  it("empty props block (just blank line after delimiter) produces empty content node", async () => {
    const md = "---\n\n\n";
    const out = await collect(deserialize([md]));
    expect(out).toEqual([{ props: {}, content: "" }]);
  });

  it("async input emits incrementally", async () => {
    async function* source(): AsyncGenerator<Node> {
      yield { props: { id: "a" }, content: "one" };
      yield { props: { id: "b" }, content: "two" };
    }
    const out = await collect(serialize(source()));
    expect(out.length).toBe(2);
    expect(out[0]).toContain("id=a");
    expect(out[1]).toContain("id=b");
  });

  it("chunked input to deserialize reassembles correctly", async () => {
    const nodes: Node[] = [
      { props: { id: "a" }, content: "alpha" },
      { props: { id: "b", parentId: "a" }, content: "bravo" },
    ];
    const full = (await collect(serialize(nodes))).join("");

    // Split at arbitrary positions: mid-line, mid-delimiter, end-of-line
    const splitPoints = [3, 7, 15, 25, 40];
    for (const pivot of splitPoints) {
      if (pivot >= full.length) continue;
      const chunks = [full.slice(0, pivot), full.slice(pivot)];
      const back = await collect(deserialize(chunks));
      expect(back).toEqual(nodes);
    }
  });

  it("single character chunks reassemble correctly", async () => {
    const nodes: Node[] = [
      { props: { id: "a" }, content: "alpha\nbeta" },
      { props: { id: "b" }, content: "gamma" },
    ];
    const full = (await collect(serialize(nodes))).join("");
    const chunks = full.split("");
    const back = await collect(deserialize(chunks));
    expect(back).toEqual(nodes);
  });

  it("ignores content outside any block (before the first delimiter)", async () => {
    const md = "preamble line 1\npreamble line 2\n---\nid=n1\n\nhello\n";
    const out = await collect(deserialize([md]));
    expect(out).toEqual([{ props: { id: "n1" }, content: "hello" }]);
  });
});
