import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it, vi } from "vitest";
import { ModelManager } from "../../src/models/model-manager.js";
import { ModelStateStore } from "../../src/models/model-state-store.js";
import type { ActivationProgress, LocalModelConfig, ModelConfig } from "../../src/models/types.js";

const REMOTE_MODEL: ModelConfig = {
  runtime: "remote",
  provider: "anthropic",
  modelId: "claude-test",
  label: "Test Claude",
};

const LOCAL_MODEL: LocalModelConfig = {
  runtime: "local",
  engine: "tjs",
  modelId: "test/local-model",
  label: "Test Local",
  family: "Test",
  dtype: "q4f16",
  size: "100 MB",
  sizeBytes: 100_000_000,
};

function createManager(catalog: Record<string, ModelConfig>, options?: { files?: MemFilesApi }) {
  const store = new ModelStateStore(catalog);
  const manager = new ModelManager({ store, files: options?.files });
  return { store, manager };
}

async function collectProgress(
  gen: AsyncGenerator<ActivationProgress>,
): Promise<ActivationProgress[]> {
  const events: ActivationProgress[] = [];
  for await (const p of gen) events.push(p);
  return events;
}

describe("ModelManager", () => {
  describe("store.getStates / store.getState", () => {
    it("initializes states for all catalog entries", () => {
      const { store } = createManager({
        "remote:test": REMOTE_MODEL,
        "local:test": LOCAL_MODEL,
      });
      const states = store.getStates();
      expect(states.size).toBe(2);
      expect(states.get("remote:test")?.status).toBe("not-downloaded");
      expect(states.get("local:test")?.status).toBe("not-downloaded");
    });

    it("returns undefined for unknown model", () => {
      const { store } = createManager({});
      expect(store.getState("nonexistent")).toBeUndefined();
    });
  });

  describe("activate remote model", () => {
    it("yields error when no API key provided", async () => {
      const { manager } = createManager({ "remote:test": REMOTE_MODEL });
      const events = await collectProgress(manager.activate("remote:test"));
      expect(events.at(-1)?.phase).toBe("error");
      expect(events.at(-1)?.message).toContain("API key");
    });
  });

  describe("activate unknown model", () => {
    it("yields error for unknown model key", async () => {
      const { manager } = createManager({});
      const events = await collectProgress(manager.activate("unknown"));
      expect(events).toHaveLength(1);
      expect(events[0]?.phase).toBe("error");
      expect(events[0]?.message).toContain("Unknown model");
    });
  });

  describe("activate local model without factory", () => {
    it("yields error when no factory registered for engine", async () => {
      const { manager } = createManager({ "local:test": LOCAL_MODEL });
      const events = await collectProgress(manager.activate("local:test"));
      expect(events.at(-1)?.phase).toBe("error");
      expect(events.at(-1)?.message).toContain("engine 'tjs'");
    });
  });

  describe("activate local model without files", () => {
    it("yields error when no FilesApi configured", async () => {
      const { manager } = createManager({ "local:test": LOCAL_MODEL });
      manager.registerLocalFactory("tjs", vi.fn());
      const events = await collectProgress(manager.activate("local:test"));
      expect(events.at(-1)?.phase).toBe("error");
      expect(events.at(-1)?.message).toContain("FilesApi");
    });
  });

  describe("store.getLanguageModel", () => {
    it("throws when model is not ready", () => {
      const { store } = createManager({ "remote:test": REMOTE_MODEL });
      expect(() => store.getLanguageModel("remote:test")).toThrow(/not ready/);
    });
  });

  describe("deactivate", () => {
    it("sets local model status back to downloaded", () => {
      const { store, manager } = createManager({ "local:test": LOCAL_MODEL });
      // Manually set to ready for this test
      store.setStatus("local:test", "ready");

      manager.deactivate("local:test");
      expect(store.getState("local:test")?.status).toBe("downloaded");
    });
  });

  describe("cancel", () => {
    it("does not throw when cancelling non-active model", () => {
      const { manager } = createManager({});
      expect(() => manager.cancel("nonexistent")).not.toThrow();
    });
  });

  describe("activate guard — downloading status", () => {
    it("yields error when model is currently downloading", async () => {
      const { store, manager } = createManager({
        "local:test": LOCAL_MODEL,
      });
      store.setStatus("local:test", "downloading");

      const events = await collectProgress(manager.activate("local:test"));
      expect(events).toHaveLength(1);
      expect(events[0]?.phase).toBe("error");
      expect(events[0]?.message).toContain("currently being downloaded");
      // Status should remain "downloading" — not changed by activate
      expect(store.getState("local:test")?.status).toBe("downloading");
    });
  });

  describe("download", () => {
    it("yields ready for remote model (no-op)", async () => {
      const { manager } = createManager({ "remote:test": REMOTE_MODEL });
      const events = await collectProgress(manager.download("remote:test"));
      expect(events).toHaveLength(1);
      expect(events[0]?.phase).toBe("ready");
    });

    it("yields ready for already-downloaded model", async () => {
      const { store, manager } = createManager({
        "local:test": LOCAL_MODEL,
      });
      store.setStatus("local:test", "downloaded");

      const events = await collectProgress(manager.download("local:test"));
      expect(events).toHaveLength(1);
      expect(events[0]?.phase).toBe("ready");
    });

    it("yields ready for already-ready model", async () => {
      const { store, manager } = createManager({
        "local:test": LOCAL_MODEL,
      });
      store.setStatus("local:test", "ready");

      const events = await collectProgress(manager.download("local:test"));
      expect(events).toHaveLength(1);
      expect(events[0]?.phase).toBe("ready");
    });

    it("yields error for unknown model", async () => {
      const { manager } = createManager({});
      const events = await collectProgress(manager.download("unknown"));
      expect(events).toHaveLength(1);
      expect(events[0]?.phase).toBe("error");
      expect(events[0]?.message).toContain("Unknown model");
    });

    it("yields error when no FilesApi configured", async () => {
      const { manager } = createManager({ "local:test": LOCAL_MODEL });
      const events = await collectProgress(manager.download("local:test"));
      expect(events.at(-1)?.phase).toBe("error");
      expect(events.at(-1)?.message).toContain("FilesApi");
    });

    it("allows download for partial status (resume)", async () => {
      const files = new MemFilesApi();
      const { store, manager } = createManager({ "local:test": LOCAL_MODEL }, { files });
      store.setStatus("local:test", "partial");

      // Mock fetch to return an empty file list so download completes quickly
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ siblings: [] }), { status: 200 }));
      try {
        const events = await collectProgress(manager.download("local:test"));
        // Should have transitioned through downloading → downloaded
        expect(store.getState("local:test")?.status).toBe("downloaded");
        expect(events.at(-1)?.phase).toBe("ready");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("sets status to downloading during download", async () => {
      const files = new MemFilesApi();
      const { store, manager } = createManager({ "local:test": LOCAL_MODEL }, { files });

      // Mock fetch to return empty file list
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ siblings: [] }), { status: 200 }));
      try {
        const statuses: string[] = [];
        store.onUpdate(() => {
          const s = store.getState("local:test")?.status;
          if (s && statuses.at(-1) !== s) statuses.push(s);
        });

        await collectProgress(manager.download("local:test"));
        expect(statuses).toContain("downloading");
        expect(statuses).toContain("downloaded");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("sets status to partial on cancellation", async () => {
      const files = new MemFilesApi();
      const { store, manager } = createManager({ "local:test": LOCAL_MODEL }, { files });

      const ac = new AbortController();
      const originalFetch = globalThis.fetch;
      let fetchCount = 0;
      globalThis.fetch = vi
        .fn()
        .mockImplementation(async (_url: string, options?: { signal?: AbortSignal }) => {
          fetchCount++;
          if (fetchCount === 1) {
            // resolveModelFiles — return one file
            return new Response(
              JSON.stringify({
                siblings: [{ rfilename: "model.onnx", size: 1000 }],
              }),
              { status: 200 },
            );
          }
          // File download — stream one chunk, then hang until aborted
          const signal = options?.signal;
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              signal?.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
          });
          return new Response(stream, { status: 200 });
        });

      try {
        const gen = manager.download("local:test", ac.signal);
        // First yield is a download progress event (from the streamed chunk)
        const first = await gen.next();
        expect(first.done).toBe(false);
        expect(store.getState("local:test")?.status).toBe("downloading");

        // Cancel
        ac.abort();
        // Drain remaining events
        const rest: ActivationProgress[] = [];
        for await (const p of gen) rest.push(p);

        expect(store.getState("local:test")?.status).toBe("partial");
        expect(store.getDownloadProgress("local:test")).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("multi-engine factory registry", () => {
    const WEBLLM_MODEL: LocalModelConfig = {
      runtime: "local",
      engine: "webllm",
      modelId: "mlc/test-model",
      label: "WebLLM Test",
      family: "Test",
      dtype: "q4f16",
      size: "100 MB",
      sizeBytes: 100_000_000,
      mlcModelLib: "https://example.com/test.wasm",
    };

    it("hasFactory returns false when nothing registered", () => {
      const { manager } = createManager({});
      expect(manager.hasFactory("tjs")).toBe(false);
      expect(manager.hasFactory("webllm")).toBe(false);
      expect(manager.hasFactory("llamacpp")).toBe(false);
    });

    it("hasFactory reports registered engines only", () => {
      const { manager } = createManager({});
      manager.registerLocalFactory("tjs", vi.fn());
      manager.registerLocalFactory("webllm", { factory: vi.fn() });
      expect(manager.hasFactory("tjs")).toBe(true);
      expect(manager.hasFactory("webllm")).toBe(true);
      expect(manager.hasFactory("llamacpp")).toBe(false);
    });

    it("dispatches to the factory matching config.engine", async () => {
      const files = new MemFilesApi();
      const { manager } = createManager(
        { "local:tjs": LOCAL_MODEL, "webllm:test": WEBLLM_MODEL },
        { files },
      );
      const tjsFactory = vi.fn().mockResolvedValue({ provider: "tjs" });
      const webllmFactory = vi.fn().mockResolvedValue({ provider: "webllm" });
      manager.registerLocalFactory("tjs", {
        factory: tjsFactory,
        fileResolver: async () => [],
        verifier: async () => true,
      });
      manager.registerLocalFactory("webllm", {
        factory: webllmFactory,
        fileResolver: async () => [],
        verifier: async () => true,
      });

      await collectProgress(manager.activate("webllm:test"));
      expect(webllmFactory).toHaveBeenCalledOnce();
      expect(tjsFactory).not.toHaveBeenCalled();
    });

    it("yields engine-specific error when no factory registered", async () => {
      const files = new MemFilesApi();
      const { manager } = createManager({ "webllm:test": WEBLLM_MODEL }, { files });
      const events = await collectProgress(manager.activate("webllm:test"));
      expect(events.at(-1)?.phase).toBe("error");
      expect(events.at(-1)?.message).toContain("engine 'webllm'");
    });

    it("refreshLocalStatuses flips on-disk models to downloaded", async () => {
      // Stale weights from a prior session must surface as "downloaded" when
      // the workspace re-opens — without this, the UI keeps showing "Download"
      // and the user is forced to re-download.
      const files = new MemFilesApi();
      const { store, manager } = createManager(
        { "local:tjs": LOCAL_MODEL, "webllm:test": WEBLLM_MODEL },
        { files },
      );
      manager.registerLocalFactory("tjs", { factory: vi.fn(), verifier: async () => true });
      manager.registerLocalFactory("webllm", { factory: vi.fn(), verifier: async () => false });
      // Seed a metadata file so hasWeights reaches the verifier for tjs.
      await files.mkdir("/models/tjs/test/local-model");
      await files.write("/models/tjs/test/local-model/model.json", [
        new TextEncoder().encode("{}"),
      ]);

      await manager.refreshLocalStatuses();

      expect(store.getState("local:tjs")?.status).toBe("downloaded");
      expect(store.getState("webllm:test")?.status).toBe("not-downloaded");
    });

    it("refreshLocalStatuses leaves ready/downloading entries untouched", async () => {
      const files = new MemFilesApi();
      const { store, manager } = createManager({ "local:tjs": LOCAL_MODEL }, { files });
      manager.registerLocalFactory("tjs", { factory: vi.fn(), verifier: async () => true });
      store.setStatus("local:tjs", "ready");

      await manager.refreshLocalStatuses();

      // Ready means the model is loaded in memory — refresh must not clobber.
      expect(store.getState("local:tjs")?.status).toBe("ready");
    });

    it("engine-namespaces storage paths", async () => {
      const files = new MemFilesApi();
      const { manager } = createManager({ "webllm:test": WEBLLM_MODEL }, { files });
      manager.registerLocalFactory("webllm", {
        factory: vi.fn().mockResolvedValue({ provider: "webllm" }),
        fileResolver: async () => [{ name: "weights.bin", size: 4 }],
        verifier: async () => false,
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-length": "4" },
        }),
      );
      try {
        await collectProgress(manager.activate("webllm:test"));
        const stored = await files.stats("/models/webllm/mlc/test-model/weights.bin");
        expect(stored?.kind).toBe("file");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
