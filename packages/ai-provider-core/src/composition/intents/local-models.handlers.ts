import type { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import type { Workspace } from "@statewalker/workspace-api";
import {
  handleCancelDownload,
  handleDeleteLocalModel,
  handleDownloadModel,
  handleListStorages,
  runActivationProgress,
} from "../../api/intents.js";
import type { StorageInfo } from "../../api/types.js";
import { ModelManager } from "../adapters.js";

/**
 * Register the four local-model lifecycle intent handlers + the
 * activation-progress broadcast wiring.
 *
 * Each handler delegates to the wrapped `ModelManager` impl from
 * `@statewalker/ai-provider`. Progress events from `manager.download(...)`
 * fan out as `ai-provider:activation-progress` broadcasts.
 */
export function registerLocalModelHandlers(workspace: Workspace, intents: Intents): () => void {
  const [register, cleanup] = newRegistry();

  register(
    handleDownloadModel(intents, (intent) => {
      void (async () => {
        try {
          const manager = workspace.requireAdapter(ModelManager).impl;
          const { catalogKey } = intent.payload;
          let lastPhase: string | undefined;
          for await (const progress of manager.download(catalogKey)) {
            runActivationProgress(intents, progress);
            lastPhase = progress.phase;
            if (progress.phase === "error") {
              intent.resolve({
                ok: false,
                error: progress.error?.message ?? progress.message,
              });
              return;
            }
          }
          intent.resolve({ ok: lastPhase === "ready" });
        } catch (err) {
          intent.resolve({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }),
  );

  register(
    handleCancelDownload(intents, (intent) => {
      try {
        const manager = workspace.requireAdapter(ModelManager).impl;
        manager.cancel(intent.payload.catalogKey);
        intent.resolve();
      } catch (err) {
        intent.reject(err);
      }
      return true;
    }),
  );

  register(
    handleDeleteLocalModel(intents, (intent) => {
      void (async () => {
        try {
          const manager = workspace.requireAdapter(ModelManager).impl;
          await manager.deleteLocal(intent.payload.catalogKey);
          intent.resolve();
        } catch (err) {
          intent.reject(err);
        }
      })();
      return true;
    }),
  );

  register(
    handleListStorages(intents, (intent) => {
      try {
        const manager = workspace.requireAdapter(ModelManager).impl;
        // Derive per-engine info from the catalog: count downloaded
        // models, sum their estimated sizes. The wrapped ModelManager
        // does not yet expose a public storage enumeration; this is
        // a best-effort projection until §7's list-models lands a
        // unified data source.
        const byEngine = new Map<string, { totalBytes: number; modelCount: number }>();
        for (const [key, config] of Object.entries(manager.store.catalog)) {
          if (config.runtime !== "local") continue;
          const state = manager.store.getState(key);
          if (!state || (state.status !== "downloaded" && state.status !== "ready")) continue;
          const engine = "engine" in config ? (config.engine as string) : "unknown";
          const entry = byEngine.get(engine) ?? { totalBytes: 0, modelCount: 0 };
          entry.modelCount += 1;
          entry.totalBytes += "approxBytes" in config ? Number(config.approxBytes ?? 0) : 0;
          byEngine.set(engine, entry);
        }
        const result: StorageInfo[] = [];
        for (const [engineId, info] of byEngine) {
          result.push({ engineId, totalBytes: info.totalBytes, modelCount: info.modelCount });
        }
        intent.resolve(result);
      } catch (err) {
        intent.reject(err);
      }
      return true;
    }),
  );

  return cleanup;
}
