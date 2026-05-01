import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  createDefaultCatalog,
  ModelManager as ModelManagerImpl,
  ModelStateStore,
} from "@statewalker/ai-provider";
import { SystemFiles, type Workspace } from "@statewalker/workspace-api";
import {
  type ActiveEmbeddingModel,
  type ActiveReasoningModel,
  ModelManager,
  ProviderSettingsStore,
} from "../public/adapters.js";

/**
 * Concrete `ModelManager` adapter. The wrapped `ModelManagerImpl` from
 * `@statewalker/ai-provider` is built on `workspace.onLoad` because it
 * needs the workspace's `SystemFiles.files` (only set after
 * `setFileSystem → open`). Disposed on `onUnload`.
 */
export class ModelManagerAdapter extends ModelManager {
  private _impl: ModelManagerImpl | undefined;

  constructor(workspace: Workspace) {
    super();
    workspace.onLoad(() => {
      const files = workspace.requireAdapter(SystemFiles).files;
      const store = new ModelStateStore(createDefaultCatalog());
      this._impl = new ModelManagerImpl({ store, files });
    });
    workspace.onUnload(() => {
      this._impl = undefined;
    });
  }

  get impl(): ModelManagerImpl {
    if (!this._impl) {
      throw new Error(
        "ModelManager: workspace is not opened. Wait for workspace.onLoad before accessing .impl",
      );
    }
    return this._impl;
  }
}

interface InternalProviderRecord {
  [providerId: string]: unknown;
}

/**
 * Minimal in-memory `ProviderSettingsStore` impl. Real file persistence
 * lands when the providers intent surface (§5) is wired — this stub
 * unblocks §3.5's activator and §3.6's end-to-end test.
 */
export class FilesBackedProviderSettingsStore extends ProviderSettingsStore {
  private readonly entries: InternalProviderRecord = {};
  private readonly listeners = new Set<(ids: string[]) => void>();

  constructor(_workspace: Workspace) {
    super();
  }

  async get(providerId: string): Promise<unknown | undefined> {
    return this.entries[providerId];
  }

  async set(providerId: string, value: unknown): Promise<void> {
    this.entries[providerId] = value;
    this.notify([providerId]);
  }

  async delete(providerId: string): Promise<boolean> {
    if (!(providerId in this.entries)) return false;
    delete this.entries[providerId];
    this.notify([providerId]);
    return true;
  }

  async list(): Promise<string[]> {
    return Object.keys(this.entries);
  }

  onUpdate(cb: (changedProviderIds: string[]) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(ids: string[]): void {
    for (const cb of this.listeners) {
      try {
        cb(ids);
      } catch (err) {
        console.error("[ai-provider-core] ProviderSettingsStore listener threw:", err);
      }
    }
  }
}

abstract class BaseActiveModelImpl {
  private _model: LanguageModelV3 | undefined;
  private _catalogKey: string | undefined;
  private _providerId: string | undefined;
  private readonly listeners = new Set<() => void>();

  protected setActive(
    model: LanguageModelV3 | undefined,
    catalogKey: string | undefined,
    providerId: string | undefined,
  ): void {
    if (
      this._model === model &&
      this._catalogKey === catalogKey &&
      this._providerId === providerId
    ) {
      return;
    }
    this._model = model;
    this._catalogKey = catalogKey;
    this._providerId = providerId;
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        console.error("[ai-provider-core] ActiveModel listener threw:", err);
      }
    }
  }

  get model(): LanguageModelV3 | undefined {
    return this._model;
  }

  get catalogKey(): string | undefined {
    return this._catalogKey;
  }

  get providerId(): string | undefined {
    return this._providerId;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

/**
 * Active reasoning-model state. Updated by the activate-model intent
 * (§8) with `role: "reasoning"`. Independent of `ActiveEmbeddingModelImpl`.
 */
export class ActiveReasoningModelImpl extends BaseActiveModelImpl implements ActiveReasoningModel {
  constructor(_workspace: Workspace) {
    super();
  }

  /** Internal — used by the activate-model intent handler in §8 and the remove-provider cascade in §5. */
  setReasoning(
    model: LanguageModelV3 | undefined,
    catalogKey: string | undefined,
    providerId: string | undefined,
  ): void {
    this.setActive(model, catalogKey, providerId);
  }
}

/**
 * Active embedding-model state. Updated by the activate-model intent
 * (§8) with `role: "embedding"`. Independent of `ActiveReasoningModelImpl`.
 */
export class ActiveEmbeddingModelImpl extends BaseActiveModelImpl implements ActiveEmbeddingModel {
  constructor(_workspace: Workspace) {
    super();
  }

  /** Internal — used by the activate-model intent handler in §8 and the remove-provider cascade in §5. */
  setEmbedding(
    model: LanguageModelV3 | undefined,
    catalogKey: string | undefined,
    providerId: string | undefined,
  ): void {
    this.setActive(model, catalogKey, providerId);
  }
}
