import type { ActivationProgress } from "@statewalker/ai-provider";
import { Intents } from "@statewalker/shared-intents";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { getWorkspace, type Workspace } from "@statewalker/workspace-api";
import { describe, expect, it } from "vitest";
import initAiProviderCore from "../../../src/index.js";
import { ModelManager } from "../../../src/public/adapters.js";
import {
  handleActivationProgress,
  runCancelDownload,
  runDeleteLocalModel,
  runDownloadModel,
  runListStorages,
} from "../../../src/public/intents.js";

interface FakeModelManagerImpl {
  downloadCalls: string[];
  cancelCalls: string[];
  deleteCalls: string[];
  signalAborted: Map<string, boolean>;
  store: { catalog: Record<string, unknown>; getState: (key: string) => undefined };
  download: (key: string, signal?: AbortSignal) => AsyncGenerator<ActivationProgress, void, void>;
  cancel: (key: string) => void;
  deleteLocal: (key: string) => Promise<void>;
}

function createFakeModelManager(): FakeModelManagerImpl {
  const fake: FakeModelManagerImpl = {
    downloadCalls: [],
    cancelCalls: [],
    deleteCalls: [],
    signalAborted: new Map(),
    store: { catalog: {}, getState: () => undefined },
    async *download(key, signal) {
      fake.downloadCalls.push(key);
      yield {
        modelKey: key,
        phase: "downloading",
        progress: 0.25,
        message: "starting",
      };
      // Allow the test to interject (e.g. dispatch cancel) at this yield point.
      await Promise.resolve();
      if (signal?.aborted) {
        fake.signalAborted.set(key, true);
        return;
      }
      yield {
        modelKey: key,
        phase: "downloading",
        progress: 0.75,
        message: "almost",
      };
      yield { modelKey: key, phase: "ready", message: "done" };
    },
    cancel(key) {
      fake.cancelCalls.push(key);
    },
    async deleteLocal(key) {
      fake.deleteCalls.push(key);
    },
  };
  return fake;
}

async function setup(): Promise<{
  ws: Workspace;
  intents: Intents;
  fakeManager: FakeModelManagerImpl;
}> {
  const ctx: Record<string, unknown> = {};
  const ws = getWorkspace(ctx);
  ws.setFileSystem(new MemFilesApi(), "test");
  initAiProviderCore(ctx);

  // Override ModelManager with a fake whose .impl is controllable.
  const fakeManager = createFakeModelManager();
  class FakeModelManagerToken extends ModelManager {
    readonly impl = fakeManager as never;
  }
  ws.setAdapter(ModelManager, FakeModelManagerToken);

  await ws.open();
  return { ws, intents: ws.requireAdapter(Intents), fakeManager };
}

describe("ai-provider local-model lifecycle intents", () => {
  describe("download-model", () => {
    it("delegates to ModelManager.download and broadcasts progress", async () => {
      const { intents, fakeManager } = await setup();
      const progressEvents: ActivationProgress[] = [];
      handleActivationProgress(intents, (intent) => {
        progressEvents.push(intent.payload);
        intent.resolve();
        return false;
      });

      const result = await runDownloadModel(intents, { catalogKey: "tjs:smollm" }).promise;

      expect(result.ok).toBe(true);
      expect(fakeManager.downloadCalls).toEqual(["tjs:smollm"]);
      expect(progressEvents.length).toBeGreaterThanOrEqual(2);
      expect(progressEvents.at(-1)?.phase).toBe("ready");
    });
  });

  describe("cancel-download", () => {
    it("calls ModelManager.cancel for the given catalogKey", async () => {
      const { intents, fakeManager } = await setup();
      await runCancelDownload(intents, { catalogKey: "tjs:smollm" }).promise;
      expect(fakeManager.cancelCalls).toEqual(["tjs:smollm"]);
    });
  });

  describe("delete-local-model", () => {
    it("calls ModelManager.deleteLocal for the given catalogKey", async () => {
      const { intents, fakeManager } = await setup();
      await runDeleteLocalModel(intents, { catalogKey: "tjs:smollm" }).promise;
      expect(fakeManager.deleteCalls).toEqual(["tjs:smollm"]);
    });
  });

  describe("list-storages", () => {
    it("resolves with an array (possibly empty)", async () => {
      const { intents } = await setup();
      const result = await runListStorages(intents, undefined).promise;
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
