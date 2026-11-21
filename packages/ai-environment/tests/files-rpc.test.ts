// The file protocol (statewalker/statewalker-root#80, #122): every holder gets a FilesApi that is a
// webrun-files-rpc client, served by the gate. The gate's files-RPC server authorizes every chunk
// it answers again, so a revocation stops a transfer at the next block even when chunks were
// already read ahead.
import { codedError } from "@statewalker/ai-access";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { FILES_RPC_METHODS, FilesRpcHost, filesOverRpc, gatedFilesRpc } from "../src/index.js";

async function fixture() {
  const store = new MemFilesApi();
  await writeText(store, "/alpha/readme.md", "alpha readme");
  await writeText(store, "/alpha/.system/access", "secret");
  await store.write("/alpha/big.bin", [new Uint8Array(64 * 1024).fill(3)]);
  let revoked = false;
  const server = gatedFilesRpc(store, {
    systemFolder: ".system",
    blockSize: 1024,
    visible: async (p) => p === "alpha",
    authorize: async (action, path) => {
      if (revoked || !path.startsWith("/alpha"))
        throw codedError("EACCES", `may not ${action} ${path}`);
    },
  });
  return { store, server, revoke: () => (revoked = true) };
}

describe("files-RPC to the gate", () => {
  it("serves the gated view to a webrun-files-rpc client", async () => {
    const { server } = await fixture();
    const files = filesOverRpc((method, args) => server.call(method, args), { blockSize: 1024 });
    expect(await readText(files, "/alpha/readme.md")).toBe("alpha readme");
    expect(await files.stats("/alpha/.system/access")).toBeUndefined();
    await writeText(files, "/alpha/new.md", "written");
    expect(await readText(files, "/alpha/new.md")).toBe("written");
    await expect(readText(files, "/beta/x")).resolves.toBe("");
  });

  it("refuses a method that is not the protocol's", async () => {
    const { server } = await fixture();
    await expect(server.call("close" as never, [])).rejects.toThrow(/ENOSYS/);
    await expect(server.call("stats", "x" as never)).rejects.toThrow(/EINVAL/);
    expect(FILES_RPC_METHODS).toContain("readChunk");
  });

  it("stops a read at the next chunk after a revocation, even with chunks read ahead", async () => {
    const { server, revoke } = await fixture();
    const { streamId } = (await server.call("openRead", ["/alpha/big.bin"])) as {
      streamId: string;
    };
    const first = (await server.call("readChunk", [streamId, 0])) as { data: Uint8Array };
    expect(first.data.length).toBe(1024);
    // The server has produced chunks ahead by now; none is answered after the revocation.
    await new Promise((r) => setTimeout(r, 10));
    revoke();
    await expect(server.call("readChunk", [streamId, 1])).rejects.toThrow(/EACCES/);
  });

  it("stops a read at the next chunk once the holder is removed from the project", async () => {
    const store = new MemFilesApi();
    await store.write("/alpha/big.bin", [new Uint8Array(64 * 1024).fill(3)]);
    let member = true;
    const server = gatedFilesRpc(store, {
      systemFolder: ".system",
      blockSize: 1024,
      visible: async (p) => p === "alpha" && member,
      authorize: async () => {},
    });
    const { streamId } = (await server.call("openRead", ["/alpha/big.bin"])) as {
      streamId: string;
    };
    await server.call("readChunk", [streamId, 0]);
    await new Promise((r) => setTimeout(r, 10));
    member = false;
    await expect(server.call("readChunk", [streamId, 1])).rejects.toThrow(/ENOENT/);
  });

  it("answers a stream opened on a hidden path as a missing file, not as an error", async () => {
    const { server } = await fixture();
    const { streamId } = (await server.call("openRead", ["/alpha/.system/access"])) as {
      streamId: string;
    };
    expect(await server.call("readChunk", [streamId, 0])).toMatchObject({ done: true });
  });

  it("stops a write at the next chunk after a revocation", async () => {
    const { server, revoke, store } = await fixture();
    const { streamId } = (await server.call("openWrite", ["/alpha/w.bin"])) as { streamId: string };
    await server.call("writeChunk", [streamId, 0, new Uint8Array([1, 2])]);
    revoke();
    await expect(server.call("writeChunk", [streamId, 1, new Uint8Array([3])])).rejects.toThrow(
      /EACCES/,
    );
    expect(await store.exists("/alpha/w.bin")).toBe(false);
  });

  it("keeps one server per holder, so a stream opened by one is unknown to another", async () => {
    const { store } = await fixture();
    const host = new FilesRpcHost((holder) =>
      gatedFilesRpc(store, {
        systemFolder: ".system",
        visible: async () => true,
        authorize: async () => {
          if (holder === "nobody") throw codedError("EACCES", "no");
        },
      }),
    );
    const { streamId } = (await host.call("ann", "openRead", ["/alpha/readme.md"])) as {
      streamId: string;
    };
    await expect(host.call("bob", "readChunk", [streamId, 0])).rejects.toThrow(/UNKNOWN_STREAM/);
    const chunk = (await host.call("ann", "readChunk", [streamId, 0])) as { data: Uint8Array };
    expect(new TextDecoder().decode(chunk.data)).toBe("alpha readme");
  });
});
