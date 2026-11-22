// Nightly (statewalker/statewalker-root#145, decided in #85): size and load. A multi-GiB file is
// written and read back block by block through the user's file view, over RPC and REST, and many
// streams run at once; every byte arrives as written. The sizes come from the environment, so a
// local run can stay small: NIGHTLY_FILE_BYTES (default 2 GiB and 3 bytes, so the last block is
// partial), NIGHTLY_STREAMS (default 64) and NIGHTLY_STREAM_BYTES (default 4 MiB). Run against the
// harness's own deployment (ai-host-do) on CellB Node, with the local workspace backend.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  type FilesClient,
  fakeModel,
  login,
  restFiles,
  rpcFiles,
  seed,
  startDeployment,
  type WorkspaceBackend,
  workspaceBackend,
} from "../../src/index.js";

const HOST = new URL("../../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const sizeOf = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const FILE_BYTES = sizeOf("NIGHTLY_FILE_BYTES", 2 * GiB + 3);
const STREAMS = sizeOf("NIGHTLY_STREAMS", 64);
const STREAM_BYTES = sizeOf("NIGHTLY_STREAM_BYTES", 4 * MiB);

/**
 * `size` deterministic pseudo-random bytes for `seed`, in chunks of at most 1 MiB that are not
 * aligned to the deployment's blocks; the same seed and size always give the same bytes.
 */
async function* bytes(seed: number, size: number): AsyncGenerator<Uint8Array> {
  let x = seed >>> 0 || 1;
  const chunk = MiB - 7;
  for (let left = size; left > 0; ) {
    const n = Math.min(chunk, left);
    const out = new Uint8Array(n);
    const words = new Uint32Array(out.buffer, 0, n >>> 2);
    for (let i = 0; i < words.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      words[i] = x >>> 0;
    }
    for (let i = words.length * 4; i < n; i++) out[i] = i & 0xff;
    yield out;
    left -= n;
  }
}

/** The sha-256 and the length of a stream of bytes. */
async function digest(stream: AsyncIterable<Uint8Array>) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const b of stream) {
    hash.update(b);
    size += b.length;
  }
  return { sha256: hash.digest("hex"), size };
}

/**
 * Runs `work` while sampling the process's memory, and answers how far its resident set grew above
 * where it started: the deployment runs in this process, so a stream held whole would show here.
 */
async function growthDuring(work: () => Promise<void>): Promise<number> {
  const start = process.memoryUsage().rss;
  let peak = start;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 50);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return Math.max(peak, process.memoryUsage().rss) - start;
}
/** Memory a multi-GiB stream may add while it runs: far below the file's size. */
const STREAM_MEMORY = 768 * MiB;

/** A REST PUT whose body streams (the REST client collects small bodies; this one may not fit). */
async function putStreaming(
  d: Deployment,
  token: string,
  path: string,
  content: AsyncIterable<Uint8Array>,
) {
  const it = content[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const r = await it.next();
      if (r.done) controller.close();
      else controller.enqueue(r.value);
    },
  });
  const res = await d.fetch(`/v1/files${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body,
    duplex: "half",
  } as RequestInit);
  expect(res.status).toBe(200);
}

let model: FakeModel;
let backend: WorkspaceBackend;
let deployment: Deployment;
let token: string;
const clients: FilesClient[] = [];

beforeAll(async () => {
  model = await fakeModel();
  backend = await workspaceBackend({ WORKSPACE_BACKEND: "local" });
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    ...backend.vars,
  });
  await seed(deployment, ADMIN_KEY, {
    "/big/readme.md": "# big\n",
    "/big/.system/access": JSON.stringify({ sizer: "editor" }),
  });
  token = await login(deployment, "sizer");
}, 120_000);
afterAll(async () => {
  for (const c of clients) c.close();
  await deployment?.close();
  await backend?.close();
  await model?.close();
});

const rpc = async () => {
  const c = await rpcFiles(deployment, token);
  clients.push(c);
  return c;
};

describe("size and load", () => {
  it(`writes and reads back a multi-GiB file block by block, over RPC and REST`, async () => {
    const expected = await digest(bytes(7, FILE_BYTES));
    expect(expected.size).toBe(FILE_BYTES);
    const files = await rpc();
    let read: unknown;
    let restRead: unknown;
    const growth = await growthDuring(async () => {
      await files.write("/big/large.bin", bytes(7, FILE_BYTES));
      read = await digest(files.read("/big/large.bin"));
      restRead = await digest(restFiles(deployment, token).read("/big/large.bin"));
    });
    expect(await files.stats("/big/large.bin")).toMatchObject({ kind: "file", size: FILE_BYTES });
    expect(read).toEqual(expected);
    expect(restRead).toEqual(expected);
    expect(growth).toBeLessThan(STREAM_MEMORY);
    // A range at the very end of the file, across the last (partial) block.
    const tail = await digest(files.read("/big/large.bin", { start: FILE_BYTES - 5 }));
    expect(tail.size).toBe(5);
    await files.remove("/big/large.bin");
  });

  it("streams a multi-GiB REST upload without holding it whole", async () => {
    const expected = await digest(bytes(11, FILE_BYTES));
    const growth = await growthDuring(() =>
      putStreaming(deployment, token, "/big/upload.bin", bytes(11, FILE_BYTES)),
    );
    expect(growth).toBeLessThan(STREAM_MEMORY);
    const files = await rpc();
    expect(await digest(files.read("/big/upload.bin"))).toEqual(expected);
    await files.remove("/big/upload.bin");
  });

  it("runs many concurrent streams over RPC and REST, each intact", async () => {
    const connections = await Promise.all(Array.from({ length: 4 }, rpc));
    const rest = restFiles(deployment, token);
    const path = (i: number) => `/big/streams/s${i}.bin`;
    const expected = await Promise.all(
      Array.from({ length: STREAMS }, (_, i) => digest(bytes(100 + i, STREAM_BYTES))),
    );
    // Writes at once: over the RPC connections, and streaming REST uploads for every third.
    await Promise.all(
      Array.from({ length: STREAMS }, (_, i) =>
        i % 3 === 2
          ? putStreaming(deployment, token, path(i), bytes(100 + i, STREAM_BYTES))
          : (connections[i % connections.length] as FilesClient).write(
              path(i),
              bytes(100 + i, STREAM_BYTES),
            ),
      ),
    );
    // Reads at once, each over another transport than its write.
    const read = await Promise.all(
      Array.from({ length: STREAMS }, (_, i) =>
        digest(
          i % 2 === 0
            ? rest.read(path(i))
            : (connections[(i + 1) % connections.length] as FilesClient).read(path(i)),
        ),
      ),
    );
    expect(read).toEqual(expected);
    await rest.remove("/big/streams");
  });
});
