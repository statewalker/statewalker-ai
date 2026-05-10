import { provideComposerAction } from "@repo/chat-mini.chat";
import {
  ActiveModel,
  type ActiveModelValue,
  AgentRuntimeAdapter,
} from "@statewalker/ai-agent-runtime";
import { provideSettingsTab } from "@statewalker/settings";
import { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import { Slots } from "@statewalker/shared-slots";
import type { Workspace } from "@statewalker/workspace-api";
import {
  PROVIDERS_MODEL_PICKER_VIEW_KEY,
  PROVIDERS_SETTINGS_TAB_VIEW_KEY,
} from "../public/constants.js";
import { provideRemoteProvider } from "../public/extension-points.js";
import { handleSelectActiveModel, type SelectActiveModelPayload } from "../public/intents.js";
import { Providers } from "../public/providers.adapter.js";
import {
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
 *   1. Reads `providers.json` from `<systemFolder>/providers.json`.
 *   2. For each configured remote / custom provider, builds a
 *      `ProviderDescriptor` and contributes it to the
 *      `providers:remote` slot.
 *   3. Resolves `config.active` against the slot snapshot and writes
 *      `ActiveModel`. Sets `AgentRuntimeAdapter` to `no-providers`
 *      / `no-active-model` when there's no resolvable selection.
 *
 * On `onUnload`: disposes slot contributions, clears `ActiveModel`,
 * resets the adapter to `loading`. The next `onLoad` re-reads from
 * disk and re-contributes — so user-edited providers.json
 * round-trips through the workspace lifecycle naturally.
 *
 * Lifetime-scoped: handles `runSelectActiveModel` even while closed
 * (no-op writes through to a not-yet-loaded config; ignored).
 */
export class ProvidersManager {
  private readonly workspace: Workspace;
  private readonly intents: Intents;
  private readonly slots: Slots;
  private readonly providers: Providers;
  private readonly activeModel: ActiveModel;
  private readonly adapter: AgentRuntimeAdapter;
  private readonly systemFolder: string;
  private readonly _cleanup: () => Promise<void>;

  // Per-cycle disposers for the slot contributions installed at
  // onLoad. Released on onUnload.
  private _slotCleanup: Array<() => void> = [];
  private _isLoaded = false;

  constructor(opts: ProvidersManagerOptions) {
    this.workspace = opts.workspace;
    this.systemFolder = opts.systemFolder ?? ".settings";
    this.intents = opts.workspace.requireAdapter(Intents);
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
      handleSelectActiveModel(this.intents, (intent) => {
        void this._persistActiveSelection(intent.payload)
          .then(() => intent.resolve())
          .catch((err) => intent.reject(err));
        return true;
      }),
    );

    // Lifetime-scoped contribution: the providers tab is always
    // available in the settings dialog regardless of workspace
    // state. The tab content (rendered via ViewRegistry) handles
    // the not-yet-loaded case itself.
    register(
      provideSettingsTab(this.slots, {
        id: "providers",
        title: "Providers",
        viewKey: PROVIDERS_SETTINGS_TAB_VIEW_KEY,
        order: 10,
      }),
    );

    // Lifetime-scoped contribution: the model picker is always
    // present in the chat composer. The renderer (ComposerModelPicker
    // in providers-views) handles the empty / unconfigured cases
    // by surfacing a "Configure providers…" affordance.
    register(
      provideComposerAction(this.slots, {
        id: "providers:model-picker",
        viewKey: PROVIDERS_MODEL_PICKER_VIEW_KEY,
        position: "leading",
        order: 10,
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
    // Tear down the prior cycle's contributions; re-contribute from
    // scratch so removed providers actually leave the slot.
    for (const dispose of this._slotCleanup) dispose();
    this._slotCleanup = [];

    const descriptors = buildDescriptors(config);
    for (const desc of descriptors) {
      this._slotCleanup.push(provideRemoteProvider(this.slots, desc));
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
    const resolved = resolveActive(
      this.slots.getSnapshot<ProviderDescriptor>("providers:remote").slice(),
      providerId,
      modelId,
    );
    if (!resolved) {
      const noProviders =
        this.slots.getSnapshot<ProviderDescriptor>("providers:remote").length === 0;
      this.adapter._setState({
        status: noProviders ? "no-providers" : "no-active-model",
      });
    }
    this.activeModel.set(resolved);
  }
}

function buildDescriptors(config: ProvidersConfig): ProviderDescriptor[] {
  const out: ProviderDescriptor[] = [];
  if (config.remote.openai?.apiKey) {
    out.push(buildOpenAIDescriptor(config.remote.openai.apiKey));
  }
  if (config.remote.anthropic?.apiKey) {
    out.push(buildAnthropicDescriptor(config.remote.anthropic.apiKey));
  }
  if (config.remote.google?.apiKey) {
    out.push(buildGoogleDescriptor(config.remote.google.apiKey));
  }
  for (const custom of config.custom) {
    if (!custom.apiKey || !custom.baseURL) continue;
    out.push(buildCustomDescriptor(custom));
  }
  return out;
}

function resolveActive(
  descriptors: readonly ProviderDescriptor[],
  providerId: string | undefined,
  modelId: string | undefined,
): ActiveModelValue | null {
  if (!providerId || !modelId) return null;
  const descriptor = descriptors.find((d) => d.id === providerId);
  if (!descriptor) return null;
  return {
    kind: "remote",
    providerId,
    modelId,
    createProvider: () => descriptor.createProvider(),
  };
}
