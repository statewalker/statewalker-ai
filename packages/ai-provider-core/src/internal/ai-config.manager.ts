import { onChange } from "@statewalker/shared-baseclass";
import { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import { DockPanelView, Layout, type PickerItem } from "@statewalker/workbench-views";
import type { Workspace } from "@statewalker/workspace-api";
import {
  ActiveEmbeddingModel,
  ActiveReasoningModel,
  ProviderSettingsStore,
} from "../public/adapters.js";
import {
  handleProvidersChanged,
  runActivateModel,
  runDeactivateModel,
  runListModels,
} from "../public/intents.js";
import type { ModelDescriptor, ModelRole } from "../public/types.js";
import { AiConfigView } from "./views/ai-config.view.js";
import { engineBadgeVariant, engineRuntimeShortName } from "./views/providers.format.js";

export const AI_CONFIG_PANEL_KEY = "ai-config:main";

const CLEAR_KEY = "";

export interface AiConfigManagerOptions {
  workspace: Workspace;
}

export class AiConfigManager {
  readonly view: AiConfigView;
  readonly panelKey: string = AI_CONFIG_PANEL_KEY;

  #workspace: Workspace;
  #intents: Intents;
  #cleanup: () => Promise<void>;
  #register: (cleanup: () => void) => () => void;

  /** Latest models per role, indexed by catalogKey. Populated by `#syncActivePicker`. */
  #modelsByRole = new Map<ModelRole, Map<string, ModelDescriptor>>();
  /** True while we are programmatically setting `picker.selectedKey` to suppress the next onUpdate dispatch. */
  #syncingPicker = new Set<ModelRole>();

  constructor(options: AiConfigManagerOptions) {
    this.#workspace = options.workspace;
    [this.#register, this.#cleanup] = newRegistry();

    this.view = new AiConfigView();
    this.view.showEmpty();

    const layout = this.#workspace.requireAdapter(Layout);
    this.#register(
      layout.publishPanel(
        new DockPanelView({
          key: this.panelKey,
          label: "AI",
          icon: "sparkles",
          area: "right",
          content: this.view,
        }),
      ),
    );

    this.#intents = this.#workspace.requireAdapter(Intents);

    this.#wireActiveModels();
    this.#wireConfigurationGate();

    if (this.#workspace.isOpened) {
      void this.#initialLoad();
    } else {
      this.#register(this.#workspace.onLoad(() => void this.#initialLoad()));
    }
  }

  close(): Promise<void> {
    return this.#cleanup();
  }

  #wireActiveModels(): void {
    const reasoningPicker = this.view.activeModels.reasoningPicker;
    const embeddingPicker = this.view.activeModels.embeddingPicker;

    this.#register(
      onChange(
        reasoningPicker.onUpdate,
        () => reasoningPicker.selectedKey,
        () => this.#onActivePicked("reasoning", reasoningPicker.selectedKey),
      ),
    );
    this.#register(
      onChange(
        embeddingPicker.onUpdate,
        () => embeddingPicker.selectedKey,
        () => this.#onActivePicked("embedding", embeddingPicker.selectedKey),
      ),
    );

    const reasoning = this.#workspace.requireAdapter(ActiveReasoningModel);
    const embedding = this.#workspace.requireAdapter(ActiveEmbeddingModel);
    this.#register(reasoning.onChange(() => void this.#syncActivePicker("reasoning")));
    this.#register(embedding.onChange(() => void this.#syncActivePicker("embedding")));
  }

  #wireConfigurationGate(): void {
    const ws = this.#workspace;
    this.#register(
      ws.requireAdapter(ProviderSettingsStore).onUpdate(() => {
        void this.#refreshConfigurationGate();
        void this.#syncActivePicker("reasoning");
        void this.#syncActivePicker("embedding");
      }),
    );
    this.#register(
      handleProvidersChanged(this.#intents, (intent) => {
        void this.#refreshConfigurationGate();
        void this.#syncActivePicker("reasoning");
        void this.#syncActivePicker("embedding");
        intent.resolve();
        return false; // observer
      }),
    );
  }

  #onActivePicked(role: ModelRole, selectedKey: string | undefined): void {
    if (this.#syncingPicker.has(role)) return;
    if (selectedKey === undefined || selectedKey === CLEAR_KEY) {
      void runDeactivateModel(this.#intents, { role }).promise.catch((err) => {
        console.error(`[ai-config.manager] deactivate ${role} failed:`, err);
      });
      return;
    }
    void runActivateModel(this.#intents, { role, catalogKey: selectedKey }).promise.catch((err) => {
      console.error(`[ai-config.manager] activate ${role} failed:`, err);
    });
  }

  async #syncActivePicker(role: ModelRole): Promise<void> {
    const intents = this.#intents;
    const models = await runListModels(intents, { role }).promise;
    const filtered = this.#filterByCuration(models);
    const card = role === "reasoning" ? this.view.activeModels.reasoning : this.view.activeModels.embedding;
    const picker = card.picker;

    const items: PickerItem[] = [
      {
        key: CLEAR_KEY,
        label: "— None —",
      },
      ...filtered.map<PickerItem>((m) => ({
        key: m.catalogKey,
        label: m.label,
        section: m.providerId,
        description: m.instanceId,
        badge: {
          label: engineRuntimeShortName(m),
          variant: engineBadgeVariant(m),
        },
      })),
    ];

    const adapter =
      role === "reasoning"
        ? this.#workspace.requireAdapter(ActiveReasoningModel)
        : this.#workspace.requireAdapter(ActiveEmbeddingModel);

    this.#syncingPicker.add(role);
    try {
      picker.items = items;
      picker.selectedKey = adapter.catalogKey ?? CLEAR_KEY;
    } finally {
      this.#syncingPicker.delete(role);
    }

    const map = new Map<string, ModelDescriptor>();
    for (const m of filtered) map.set(m.catalogKey, m);
    this.#modelsByRole.set(role, map);

    const active = adapter.catalogKey ? map.get(adapter.catalogKey) : undefined;
    card.providerCaption.text = active ? active.providerId : "";
  }

  /** Filter models by per-provider `selectedModelIds` curation (B4 wires this). */
  #filterByCuration(models: readonly ModelDescriptor[]): ModelDescriptor[] {
    return [...models];
  }

  async #refreshConfigurationGate(): Promise<void> {
    const store = this.#workspace.requireAdapter(ProviderSettingsStore);
    const keys = await store.list();
    if (keys.length > 0) {
      this.view.showConfigured();
    } else {
      this.view.showEmpty();
    }
  }

  async #initialLoad(): Promise<void> {
    await Promise.all([
      this.#syncActivePicker("reasoning"),
      this.#syncActivePicker("embedding"),
      this.#refreshConfigurationGate(),
    ]);
  }
}
