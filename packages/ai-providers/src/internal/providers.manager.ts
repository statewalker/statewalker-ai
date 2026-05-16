import {
  ActiveModel,
  type ActiveModelValue,
  AgentRuntimeAdapter,
} from "@statewalker/ai-agent-runtime";
import { Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import { Slots } from "@statewalker/shared-slots";
import type { Workspace } from "@statewalker/workspace";
import { remoteProvidersSlot } from "../public/extension-points.js";
import { SelectActiveModelCommand, type SelectActiveModelPayload } from "../public/intents.js";
import { Providers } from "../public/providers.adapter.js";
import {
  type Connection,
  emptyProvidersConfig,
  loadProvidersConfig,
  type ProvidersConfig,
  saveProvidersConfig,
} from "../public/providers-store.js";
import type { ProviderDescriptor } from "../public/types.js";
import { buildAnthropicDescriptor } from "./builtins/anthropic.js";
import { buildCustomDescriptor } from "./builtins/custom.js";
import { buildGoogleDescriptor } from "./builtins/google.js";
import { buildOpenAIDescriptor } from "./builtins/openai.js";

export interface ProvidersManagerOptions {
  workspace: Workspace;
  systemFolder?: string;
}

/**
 * Re-entrant orchestrator for the providers fragment. On each
 * `workspace.onLoad`:
 *   1. Reads `providers.json` from `<systemFolder>/providers.json`
 *      (with automatic v1→v2→v3→v4 migration).
 *   2. For each Connection, builds a `ProviderDescriptor` and
 *      contributes it to the `providers:remote` slot.
 *   3. Resolves `config.active` against the slot snapshot and writes
 *      `ActiveModel`. Sets `AgentRuntimeAdapter` to `no-providers`
 *      / `no-active-model` when there's no resolvable selection.
 *
 * On `onUnload`: disposes slot contributions, clears `ActiveModel`,
 * resets the adapter to `loading`.
 */
export class ProvidersManager {
  private readonly workspace: Workspace;
  private readonly intents: Commands;
  private readonly slots: Slots;
  private readonly providers: Providers;
  private readonly activeModel: ActiveModel;
  private readonly adapter: AgentRuntimeAdapter;
  private readonly systemFolder: string;
  private readonly _cleanup: () => Promise<void>;

  private _slotCleanup: Array<() => void> = [];
  private _isLoaded = false;

  constructor(opts: ProvidersManagerOptions) {
    this.workspace = opts.workspace;
    this.systemFolder = opts.systemFolder ?? ".settings";
    this.intents = opts.workspace.requireAdapter(Commands);
    this.slots = opts.workspace.requireAdapter(Slots);
    this.providers = opts.workspace.requireAdapter(Providers);
    this.activeModel = opts.workspace.requireAdapter(ActiveModel);
    this.adapter = opts.workspace.requireAdapter(AgentRuntimeAdapter);

    this.providers._setSystemFolder(this.systemFolder);
    this.providers._attach({
      saveProviders: (next) => this._saveProviders(next),
      reload: () => this._reload(),
    });

    const [register, cleanup] = newRegistry();
    this._cleanup = cleanup;

    register(
      this.intents.listen(SelectActiveModelCommand, (cmd) => {
        void this._persistActiveSelection(cmd.payload)
          .then(() => cmd.resolve())
          .catch((err) => cmd.reject(err));
        return true;
      }),
    );

    register(opts.workspace.onLoad(() => void this._onLoad()));
    register(opts.workspace.onUnload(() => this._onUnload()));

    if (opts.workspace.isOpened) void this._onLoad();
  }

  async close(): Promise<void> {
    if (this._isLoaded) this._onUnload();
    await this._cleanup();
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  private async _onLoad(): Promise<void> {
    if (this._isLoaded) return;
    this._isLoaded = true;
    try {
      const config = await loadProvidersConfig(this.workspace.files, this.systemFolder);
      this._applyConfig(config);
    } catch (error) {
      this.adapter._setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private _onUnload(): void {
    if (!this._isLoaded) return;
    this._isLoaded = false;
    for (const dispose of this._slotCleanup) {
      try {
        dispose();
      } catch (err) {
        console.error("[providers] slot cleanup threw:", err);
      }
    }
    this._slotCleanup = [];
    this.providers._setConfig(emptyProvidersConfig);
    this.activeModel.clear();
    this.adapter._setState({ status: "loading" });
  }

  // ── Imperative API (called by Providers.saveProviders / reload) ──

  private async _saveProviders(next: ProvidersConfig): Promise<void> {
    if (!this._isLoaded) return;
    await saveProvidersConfig(this.workspace.files, this.systemFolder, next);
    this._applyConfig(next);
  }

  private async _reload(): Promise<void> {
    if (!this._isLoaded) return;
    const config = await loadProvidersConfig(this.workspace.files, this.systemFolder);
    this._applyConfig(config);
  }

  // ── Slot + ActiveModel writers ────────────────────────────────

  private _applyConfig(config: ProvidersConfig): void {
    for (const dispose of this._slotCleanup) dispose();
    this._slotCleanup = [];

    const descriptors = buildDescriptors(config);
    for (const desc of descriptors) {
      this._slotCleanup.push(this.slots.provide(remoteProvidersSlot, desc));
    }

    this.providers._setConfig(config);
    this._applyActiveSelection(config.active);
  }

  private async _persistActiveSelection(selection: SelectActiveModelPayload): Promise<void> {
    if (!this._isLoaded) {
      this._applyActiveSelection(selection);
      return;
    }
    const next: ProvidersConfig = {
      ...this.providers.config,
      active: { providerId: selection.providerId, modelId: selection.modelId },
    };
    await this._saveProviders(next);
  }

  private _applyActiveSelection(
    selection: SelectActiveModelPayload | ProvidersConfig["active"],
  ): void {
    const { providerId, modelId } = selection;
    // Local models are owned by the `models-config` fragment: it
    // writes `ActiveModel { kind: "local" }` and drives activation.
    // This manager only handles the remote-Connection case.
    if (providerId === "local") return;
    const resolved = resolveActive(
      this.slots.getSnapshot(remoteProvidersSlot).slice(),
      providerId,
      modelId,
    );
    if (!resolved) {
      const noProviders = this.slots.getSnapshot(remoteProvidersSlot).length === 0;
      this.adapter._setState({
        status: noProviders ? "no-providers" : "no-active-model",
      });
    }
    this.activeModel.set(resolved);
  }
}

function buildDescriptor(c: Connection): ProviderDescriptor {
  switch (c.type) {
    case "openai":
      return buildOpenAIDescriptor(c);
    case "anthropic":
      return buildAnthropicDescriptor(c);
    case "google":
      return buildGoogleDescriptor(c);
    case "openai-compatible":
      return buildCustomDescriptor(c);
  }
}

function buildDescriptors(config: ProvidersConfig): ProviderDescriptor[] {
  return config.connections.filter((c) => c.apiKey).map((c) => buildDescriptor(c));
}

function resolveActive(
  descriptors: readonly ProviderDescriptor[],
  providerId: string | undefined,
  modelId: string | undefined,
): ActiveModelValue | null {
  if (!providerId || !modelId) return null;
  // `providerId === "local"` is handled by the local-models fragment
  // by writing `ActiveModel` directly; this fragment only resolves
  // remote connections.
  if (providerId === "local") return null;
  const descriptor = descriptors.find((d) => d.id === providerId);
  if (!descriptor) return null;
  return {
    kind: "remote",
    providerId,
    modelId,
    createProvider: () => descriptor.createProvider(),
  };
}
