import { describe, expect, it, vi } from "vitest";
import { ModelStateStore } from "../src/model-state-store.js";
import type { ActivationProgress, ModelConfig } from "../src/types.js";

const LOCAL_MODEL: ModelConfig = {
  runtime: "local",
  modelId: "test/local-model",
  label: "Test Local",
  family: "Test",
  dtype: "q4f16",
  size: "100 MB",
  sizeBytes: 100_000_000,
};

function createStore() {
  return new ModelStateStore({ "local:test": LOCAL_MODEL });
}

function makeProgress(
  key: string,
  overrides?: Partial<ActivationProgress>,
): ActivationProgress {
  return {
    modelKey: key,
    phase: "downloading",
    progress: 0.5,
    bytesDownloaded: 50_000_000,
    bytesTotal: 100_000_000,
    message: "Downloading...",
    ...overrides,
  };
}

describe("ModelStateStore — download progress", () => {
  it("setDownloadProgress stores and getDownloadProgress retrieves", () => {
    const store = createStore();
    const progress = makeProgress("local:test");

    store.setDownloadProgress("local:test", progress);

    expect(store.getDownloadProgress("local:test")).toBe(progress);
  });

  it("getDownloadProgress returns undefined for non-downloading model", () => {
    const store = createStore();
    expect(store.getDownloadProgress("local:test")).toBeUndefined();
  });

  it("clearDownloadProgress removes the entry", () => {
    const store = createStore();
    store.setDownloadProgress("local:test", makeProgress("local:test"));

    store.clearDownloadProgress("local:test");

    expect(store.getDownloadProgress("local:test")).toBeUndefined();
  });

  it("clearDownloadProgress is a no-op for non-existing key", () => {
    const store = createStore();
    const listener = vi.fn();
    store.onUpdate(listener);

    store.clearDownloadProgress("nonexistent");

    expect(listener).not.toHaveBeenCalled();
  });

  it("getActiveDownloads returns a snapshot of all download progress entries", () => {
    const store = new ModelStateStore({
      "local:a": LOCAL_MODEL,
      "local:b": LOCAL_MODEL,
    });

    store.setDownloadProgress("local:a", makeProgress("local:a"));
    store.setDownloadProgress("local:b", makeProgress("local:b"));

    const downloads = store.getActiveDownloads();
    expect(downloads.size).toBe(2);
    expect(downloads.has("local:a")).toBe(true);
    expect(downloads.has("local:b")).toBe(true);
  });

  it("getActiveDownloads returns a copy, not the internal map", () => {
    const store = createStore();
    store.setDownloadProgress("local:test", makeProgress("local:test"));

    const downloads = store.getActiveDownloads();
    downloads.delete("local:test");

    expect(store.getDownloadProgress("local:test")).toBeDefined();
  });

  it("setDownloadProgress notifies listeners", () => {
    const store = createStore();
    const listener = vi.fn();
    store.onUpdate(listener);

    store.setDownloadProgress("local:test", makeProgress("local:test"));

    expect(listener).toHaveBeenCalledOnce();
  });

  it("clearDownloadProgress notifies listeners when entry exists", () => {
    const store = createStore();
    store.setDownloadProgress("local:test", makeProgress("local:test"));

    const listener = vi.fn();
    store.onUpdate(listener);
    store.clearDownloadProgress("local:test");

    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("ModelStateStore — downloading/partial statuses", () => {
  it("setStatus accepts 'downloading'", () => {
    const store = createStore();
    store.setStatus("local:test", "downloading");
    expect(store.getState("local:test")?.status).toBe("downloading");
  });

  it("setStatus accepts 'partial'", () => {
    const store = createStore();
    store.setStatus("local:test", "partial");
    expect(store.getState("local:test")?.status).toBe("partial");
  });

  it("transitions partial → downloading → downloaded", () => {
    const store = createStore();

    store.setStatus("local:test", "partial");
    expect(store.getState("local:test")?.status).toBe("partial");

    store.setStatus("local:test", "downloading");
    expect(store.getState("local:test")?.status).toBe("downloading");

    store.setStatus("local:test", "downloaded");
    expect(store.getState("local:test")?.status).toBe("downloaded");
  });
});
