import type { LocalModelConfig, ModelManager as ModelManagerImpl } from "@statewalker/ai-provider";
import { onChange as onChangeRaw } from "@statewalker/shared-baseclass";

/**
 * `onChange` wrapper with intuitive arg order: `(onUpdate, getValue, callback)`.
 * The shared-baseclass version uses `(onUpdate, callback, getValue)` which
 * is easy to confuse, especially because both extras are zero-arg functions.
 */
function onChange(
  onUpdate: (cb: () => void) => () => void,
  getValue: () => unknown,
  callback: () => void,
): () => void {
  return onChangeRaw(onUpdate, callback, getValue);
}

import { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import {
  ActionView,
  Dialogs,
  DialogView,
  DockPanelView,
  FlexView,
  Keyboard,
  Layout,
  MainMenu,
  type PickerItem,
} from "@statewalker/workbench-views";
import type { Workspace } from "@statewalker/workspace-api";
import {
  ActiveEmbeddingModel,
  ActiveReasoningModel,
  ModelManager,
  ProviderSettingsStore,
} from "../public/adapters.js";
import {
  handleOpen,
  runActivateModel,
  runCancelDownload,
  runConfigureProvider,
  runDeactivateModel,
  runDeleteLocalModel,
  runDownloadModel,
  runListModels,
  runListProviders,
  runOpen,
} from "../public/intents.js";
import type {
  ConfigureProviderSettings,
  ModelDescriptor,
  ModelRole,
  ProviderDescriptor,
  ProviderName,
} from "../public/types.js";
import { AddProviderDialogBodyView } from "./views/add-provider-dialog.view.js";
import { AiConfigView } from "./views/ai-config.view.js";
import { engineBadgeVariant, engineRuntimeShortName } from "./views/providers.format.js";
import type { ConnectionStatus } from "./views/providers.types.js";
import { RemoteModelCardView } from "./views/remote-model-card.view.js";
import { RemoteProviderFormView } from "./views/remote-provider-form.view.js";
import { TransformersModelCardView } from "./views/transformers-model-card.view.js";
import {
  type VariantStatus,
  WebllmModelCardView,
  WebllmVariantRow,
} from "./views/webllm-model-card.view.js";

export const AI_CONFIG_PANEL_KEY = "ai-config:main";

const CLEAR_KEY = "";

/** Predefined remote provider sub-tabs that always appear in the Remote
 *  tab, regardless of whether the user has configured them. */
const STANDARD_REMOTE_PROVIDERS: ReadonlyArray<{
  providerId: string;
  providerName: ProviderName;
  label: string;
}> = [
  { providerId: "openai", providerName: "openai", label: "OpenAI" },
  { providerId: "anthropic", providerName: "anthropic", label: "Anthropic" },
  { providerId: "google", providerName: "google", label: "Google" },
];

interface RemoteProviderSnapshot {
  descriptor: ProviderDescriptor;
  settings: Partial<ConfigureProviderSettings> & { providerName: ProviderName; label: string };
  selectedModelIds: Set<string>;
}

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

  /** True while we are programmatically setting `picker.selectedKey` to suppress the next onUpdate dispatch. */
  #syncingPicker = new Set<ModelRole>();
  /** Per-provider connection status cache. Not persisted. */
  #connectionStatus = new Map<string, ConnectionStatus>();
  /** Latest provider snapshots (descriptor + stored settings + selected ids). */
  #providers: RemoteProviderSnapshot[] = [];
  /** Active sub-tab key in the Remote tab. */
  #activeRemoteKey: string | undefined;
  /** Currently bound RemoteProviderFormView (one shared form, rebinds on tab change). */
  #remoteForm: RemoteProviderFormView | undefined;
  /** Disposers for the per-form bindings (cleared when the form rebinds). */
  #remoteFormDisposers: Array<() => void> = [];
  /** Disposer returned by `Layout.publishPanel`; non-undefined while the
   *  panel is currently published. */
  #unpublishPanel: (() => void) | undefined;

  constructor(options: AiConfigManagerOptions) {
    this.#workspace = options.workspace;
    [this.#register, this.#cleanup] = newRegistry();

    this.view = new AiConfigView();

    this.#intents = this.#workspace.requireAdapter(Intents);

    // Eagerly construct ModelManager so its workspace.onLoad subscription
    // is registered BEFORE this manager's #initialLoad subscription.
    // Otherwise our initial load fires first, calls runListModels which
    // needs ModelManager.impl, but the adapter's _impl hasn't been
    // populated yet (its own onLoad runs after ours).
    try {
      this.#workspace.requireAdapter(ModelManager);
    } catch {
      // ignore — engine packages may register the adapter later
    }

    this.#wireActiveModels();
    this.#wireConfigurationGate();
    this.#wireRemoteSubTabs();
    this.#wireAddProviderTriggers();
    this.#wireWebllmTab();
    this.#wireTransformersTab();
    this.#wireActivationProgress();
    this.#wireOpenFocus();
    this.#wireKeyboardShortcut();
    this.#wireSettingsMenu();

    // Panel lifecycle:
    //   - publish on workspace.onLoad (the AI configurator depends on the
    //     workspace's SystemFiles for ProviderSettingsStore + ModelManager,
    //     so the panel must NOT appear before the workspace is activated)
    //   - unpublish on workspace.onUnload so it disappears when the
    //     workspace closes (e.g. user switches workspace)
    //   - also unpublish on manager close() so the activator's cleanup
    //     tears the panel down regardless of workspace state
    this.#register(this.#workspace.onLoad(() => this.#publishPanel()));
    this.#register(this.#workspace.onUnload(() => this.#removePanel()));
    this.#register(() => this.#removePanel());

    if (this.#workspace.isOpened) {
      this.#publishPanel();
      void this.#initialLoad();
    } else {
      this.#register(this.#workspace.onLoad(() => void this.#initialLoad()));
    }
  }

  close(): Promise<void> {
    return this.#cleanup();
  }

  #publishPanel(): void {
    if (this.#unpublishPanel) return;
    const layout = this.#workspace.requireAdapter(Layout);
    this.#unpublishPanel = layout.publishPanel(
      new DockPanelView({
        key: this.panelKey,
        label: "AI",
        icon: "sparkles",
        area: "right",
        content: this.view,
      }),
    );
  }

  #removePanel(): void {
    if (!this.#unpublishPanel) return;
    this.#unpublishPanel();
    this.#unpublishPanel = undefined;
  }

  // ── Active models ─────────────────────────────────────────────────

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
    const models = await runListModels(this.#intents, { role }).promise;
    const card =
      role === "reasoning" ? this.view.activeModels.reasoning : this.view.activeModels.embedding;
    const picker = card.picker;

    const items: PickerItem[] = [
      { key: CLEAR_KEY, label: "— None —" },
      ...models.map<PickerItem>((m) => ({
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
    for (const m of models) map.set(m.catalogKey, m);
    const active = adapter.catalogKey ? map.get(adapter.catalogKey) : undefined;
    card.providerCaption.text = active ? active.providerId : "";
  }

  // ── Configuration gate ───────────────────────────────────────────

  #wireConfigurationGate(): void {
    const ws = this.#workspace;
    // Single source of truth: ProviderSettingsStore.onUpdate fires after
    // every set/delete. Subscribing to handleProvidersChanged additionally
    // would double-refresh and (because runProvidersChanged is dispatched
    // synchronously inside the configure-provider handler before
    // intent.resolve) can re-enter the dispatch loop.
    this.#register(
      ws.requireAdapter(ProviderSettingsStore).onUpdate(() => {
        void this.#refreshAll().catch((err) => {
          console.error("[ai-config.manager] refreshAll failed:", err);
        });
      }),
    );
  }

  // ── Remote sub-tabs ──────────────────────────────────────────────

  #wireRemoteSubTabs(): void {
    const subTabs = this.view.remoteProviders.subTabs;
    this.#register(
      onChange(
        subTabs.onUpdate,
        () => subTabs.selectedKey,
        () => {
          if (subTabs.selectedKey && subTabs.selectedKey !== this.#activeRemoteKey) {
            this.#bindRemoteForm(subTabs.selectedKey);
          }
        },
      ),
    );
  }

  async #refreshRemoteProviders(): Promise<void> {
    const descriptors = await runListProviders(this.#intents, { runtime: "remote" }).promise;
    const store = this.#workspace.requireAdapter(ProviderSettingsStore);

    type StoredRaw = Partial<ConfigureProviderSettings> & {
      providerId?: string;
      instanceId?: string;
      providerName?: ProviderName;
      label?: string;
    };

    const buildSnapshot = async (
      descriptor: ProviderDescriptor,
    ): Promise<RemoteProviderSnapshot> => {
      const key = descriptor.instanceId
        ? `${descriptor.providerId}#${descriptor.instanceId}`
        : descriptor.providerId;
      const raw = (await store.get(key)) as StoredRaw | undefined;
      const settings = {
        providerName: raw?.providerName ?? descriptor.providerName,
        label: raw?.label ?? descriptor.label,
        apiKey: raw?.apiKey,
        authToken: raw?.authToken,
        baseURL: raw?.baseURL,
        headers: raw?.headers,
        selectedModelIds: raw?.selectedModelIds,
      };
      return {
        descriptor,
        settings,
        selectedModelIds: new Set(raw?.selectedModelIds ?? []),
      };
    };

    // Always-present standard provider tabs (OpenAI / Anthropic / Google).
    // These appear even when no settings are configured, so the user can
    // pick any of them and enter an API key without prior setup.
    const standardSnapshots: RemoteProviderSnapshot[] = [];
    for (const std of STANDARD_REMOTE_PROVIDERS) {
      const existing = descriptors.find((d) => d.providerId === std.providerId && !d.instanceId);
      const placeholderDescriptor: ProviderDescriptor = existing ?? {
        providerId: std.providerId,
        providerName: std.providerName,
        label: std.label,
        runtime: "remote",
        hasCredentials: false,
      };
      standardSnapshots.push(await buildSnapshot(placeholderDescriptor));
    }

    // Custom (openai-compatible#instance) tabs added via the Add Provider dialog.
    const customSnapshots: RemoteProviderSnapshot[] = [];
    for (const d of descriptors) {
      if (d.providerId !== "openai-compatible") continue;
      customSnapshots.push(await buildSnapshot(d));
    }

    const snapshots = [...standardSnapshots, ...customSnapshots];
    this.#providers = snapshots;

    const view = this.view.remoteProviders;
    const form = this.#getOrCreateForm();
    view.setForm(form);

    view.subTabs.tabs = snapshots.map((s) => {
      const sub = this.#subTabKey(s.descriptor);
      return {
        key: sub,
        label: s.settings.label,
        content: form,
      };
    });

    let selected = view.subTabs.selectedKey;
    if (!selected || !view.subTabs.tabs.some((t: { key: string }) => t.key === selected)) {
      selected = view.subTabs.tabs[0]?.key ?? "";
      view.subTabs.selectedKey = selected;
    }
    if (selected) this.#bindRemoteForm(selected);
  }

  #subTabKey(d: ProviderDescriptor): string {
    return d.instanceId ? `${d.providerId}#${d.instanceId}` : d.providerId;
  }

  #snapshotByKey(key: string): RemoteProviderSnapshot | undefined {
    return this.#providers.find((s) => this.#subTabKey(s.descriptor) === key);
  }

  #getOrCreateForm(): RemoteProviderFormView {
    if (!this.#remoteForm) {
      this.#remoteForm = new RemoteProviderFormView({
        key: "ai-config:remote-form",
        providerName: "",
        isCompatible: false,
      });
    }
    return this.#remoteForm;
  }

  #disposeRemoteFormBindings(): void {
    for (const d of this.#remoteFormDisposers) d();
    this.#remoteFormDisposers = [];
  }

  #bindRemoteForm(subTabKey: string): void {
    const snapshot = this.#snapshotByKey(subTabKey);
    if (!snapshot) return;
    this.#activeRemoteKey = subTabKey;
    const form = this.#getOrCreateForm();

    this.#disposeRemoteFormBindings();

    // Re-populate fields from the snapshot.
    form.setProviderName(snapshot.settings.label);
    form.setIsCompatible(snapshot.descriptor.providerName === "openai-compatible");
    form.apiKeyField.value = snapshot.settings.apiKey ?? "";
    form.endpointField.value = snapshot.settings.baseURL ?? "";
    form.errorAlert.content = "";
    form.setSelectedCount(snapshot.selectedModelIds.size);
    form.setConnectionStatus(this.#connectionStatus.get(subTabKey) ?? "untested");

    // Field updates → "untested"
    this.#remoteFormDisposers.push(
      onChange(
        form.apiKeyField.onUpdate,
        () => form.apiKeyField.value,
        () => this.#updateConnectionStatus(subTabKey, "untested"),
      ),
    );
    this.#remoteFormDisposers.push(
      onChange(
        form.endpointField.onUpdate,
        () => form.endpointField.value,
        () => this.#updateConnectionStatus(subTabKey, "untested"),
      ),
    );

    // Reveal toggle: flip apiKeyField.type.
    this.#remoteFormDisposers.push(
      form.revealAction.onSubmit(() => {
        form.apiKeyField.type = form.apiKeyField.type === "password" ? "text" : "password";
      }),
    );

    // Test connection: dispatch runConfigureProvider({ test: true }).
    this.#remoteFormDisposers.push(
      form.testAction.onSubmit(() => {
        void this.#onTestConnection(subTabKey);
      }),
    );

    // Search / capability filter → re-render the model grid.
    this.#remoteFormDisposers.push(
      onChange(
        form.searchField.onUpdate,
        () => form.searchField.value,
        () => void this.#syncRemoteForm(),
      ),
    );
    this.#remoteFormDisposers.push(
      form.capabilityFilter.onUpdate(() => void this.#syncRemoteForm()),
    );

    // Trigger a render of the model grid.
    void this.#syncRemoteForm();
  }

  async #onTestConnection(subTabKey: string): Promise<void> {
    const snapshot = this.#snapshotByKey(subTabKey);
    if (!snapshot) return;
    const form = this.#remoteForm;
    if (!form) return;

    this.#updateConnectionStatus(subTabKey, "testing");
    try {
      const result = await runConfigureProvider(this.#intents, {
        providerId: snapshot.descriptor.providerId,
        instanceId: snapshot.descriptor.instanceId,
        settings: {
          ...snapshot.settings,
          apiKey: form.apiKeyField.value || undefined,
          baseURL: form.endpointField.value || undefined,
        },
        test: true,
      }).promise;
      if (result.ok) {
        this.#updateConnectionStatus(subTabKey, "connected");
        form.errorAlert.content = "";
      } else {
        this.#updateConnectionStatus(subTabKey, "failed");
        form.errorAlert.content = result.error ?? "Connection failed";
      }
    } catch (err) {
      this.#updateConnectionStatus(subTabKey, "failed");
      form.errorAlert.content = err instanceof Error ? err.message : String(err);
    }
  }

  #updateConnectionStatus(subTabKey: string, status: ConnectionStatus): void {
    this.#connectionStatus.set(subTabKey, status);
    if (this.#activeRemoteKey === subTabKey && this.#remoteForm) {
      this.#remoteForm.setConnectionStatus(status);
    }
  }

  async #syncRemoteForm(): Promise<void> {
    const subTabKey = this.#activeRemoteKey;
    if (!subTabKey) return;
    const snapshot = this.#snapshotByKey(subTabKey);
    const form = this.#remoteForm;
    if (!snapshot || !form) return;

    const all = await runListModels(this.#intents, {
      providerId: snapshot.descriptor.providerId,
      instanceId: snapshot.descriptor.instanceId,
      runtime: "remote",
    }).promise;

    const search = form.searchField.value.trim().toLowerCase();
    const capabilityKeys = [...form.capabilityFilter.selectedKeys];
    const capability = capabilityKeys[0] ?? "all";
    const filtered = all.filter((m) => {
      if (
        search &&
        !m.label.toLowerCase().includes(search) &&
        !m.catalogKey.toLowerCase().includes(search)
      ) {
        return false;
      }
      if (capability === "reasoning" && !m.kinds.includes("reasoning")) return false;
      if (capability === "embedding" && !m.kinds.includes("embedding")) return false;
      return true;
    });

    const cards = filtered.map((m) => {
      const card = new RemoteModelCardView({
        key: `remote-card:${m.catalogKey}`,
        modelId: m.catalogKey,
        label: m.label,
        selected: snapshot.selectedModelIds.has(m.catalogKey),
        contextWindow: m.contextWindow,
        capabilityBadges: m.kinds.map((k) => ({ label: k, variant: "neutral" as const })),
      });
      card.selectAction.onSubmit(() => {
        void this.#toggleSelected(subTabKey, m.catalogKey);
      });
      return card;
    });
    form.modelsGrid.setChildren(cards);
    form.setSelectedCount(snapshot.selectedModelIds.size);
  }

  async #toggleSelected(subTabKey: string, catalogKey: string): Promise<void> {
    const snapshot = this.#snapshotByKey(subTabKey);
    if (!snapshot) return;
    const next = new Set(snapshot.selectedModelIds);
    if (next.has(catalogKey)) next.delete(catalogKey);
    else next.add(catalogKey);
    snapshot.selectedModelIds = next;

    await runConfigureProvider(this.#intents, {
      providerId: snapshot.descriptor.providerId,
      instanceId: snapshot.descriptor.instanceId,
      settings: {
        ...snapshot.settings,
        selectedModelIds: [...next],
      },
    }).promise;
    // The providers-changed broadcast triggers #refreshAll, which re-renders the grid.
  }

  // ── Add Provider triggers (B5 lands the dialog itself) ───────────

  #wireAddProviderTriggers(): void {
    this.#register(
      this.view.remoteProviders.addProviderAction.onSubmit(() => this.#openAddProviderDialog()),
    );
  }

  #openAddProviderDialog(): void {
    const body = new AddProviderDialogBodyView();
    const dialogs = this.#workspace.requireAdapter(Dialogs);
    let removeDialog: (() => void) | undefined;

    // Clear any prior error on the Name field once the user starts typing.
    body.nameField.onUpdate(() => {
      if (body.nameField.value.trim() && body.nameField.errorMessage) {
        body.nameField.errorMessage = undefined;
      }
    });

    const dialog = new DialogView({
      key: "ai-config:add-provider-dialog",
      size: "md",
      header: "Add custom provider",
      children: [body],
      isOpen: true,
      buttons: [
        { label: "Cancel" },
        {
          label: "Add",
          variant: "default",
          onClick: () => {
            const name = body.nameField.value.trim();
            if (!name) {
              // Show validation feedback rather than silently keeping the
              // dialog open with no signal — empty name is the most common
              // way users get stuck on the form.
              body.nameField.errorMessage = "Name is required";
              return false;
            }
            const apiKey = body.apiKeyField.value.trim();
            const baseURL = body.endpointField.value.trim();
            void runConfigureProvider(this.#intents, {
              providerId: "openai-compatible",
              instanceId: name,
              settings: {
                providerName: "openai-compatible" as ProviderName,
                label: name,
                apiKey: apiKey || undefined,
                baseURL: baseURL || undefined,
              },
            }).promise.then((result) => {
              if (!result.ok) {
                console.error("[ai-config.manager] add provider failed:", result.error);
              }
              removeDialog?.();
            });
            return true;
          },
        },
      ],
    });
    removeDialog = dialogs.add(dialog);
  }

  // ── WebLLM tab ───────────────────────────────────────────────────

  /** Track WebLLM family chip's previously-selected key so we can implement
   *  "click again to clear". */
  #webllmFamilyPrev: string | undefined;

  #wireWebllmTab(): void {
    const tab = this.view.webllm;

    this.#register(
      onChange(
        tab.enabledSwitch.onUpdate,
        () => tab.enabledSwitch.isSelected,
        () => void this.#onLocalProviderEnabledChange("webllm", tab.enabledSwitch.isSelected),
      ),
    );

    this.#register(
      onChange(
        tab.searchField.onUpdate,
        () => tab.searchField.value,
        () => void this.#syncWebllmAccordion(),
      ),
    );
    this.#register(
      onChange(
        tab.familyFilter.onUpdate,
        () => [...tab.familyFilter.selectedKeys].join(","),
        () => {
          // "click active chip again to clear" behaviour.
          const next = [...tab.familyFilter.selectedKeys][0];
          if (next && next === this.#webllmFamilyPrev) {
            tab.familyFilter.setSelected([]);
            this.#webllmFamilyPrev = undefined;
          } else {
            this.#webllmFamilyPrev = next;
          }
          void this.#syncWebllmAccordion();
        },
      ),
    );

    // Live updates from ModelManager state (downloads progress / status).
    if (this.#workspace.isOpened) {
      this.#subscribeModelManager();
    } else {
      this.#register(this.#workspace.onLoad(() => this.#subscribeModelManager()));
    }
  }

  #subscribeModelManager(): void {
    try {
      const manager = this.#workspace.requireAdapter(ModelManager).impl;
      // Some test fakes don't expose `onUpdate`; guard for that.
      if (typeof manager.store.onUpdate !== "function") return;
      this.#register(
        manager.store.onUpdate(() => {
          void this.#syncWebllmAccordion();
          void this.#syncTransformersGrid();
        }),
      );
    } catch {
      // ModelManager may not be ready yet; the onLoad subscription will retry.
    }
  }

  async #onLocalProviderEnabledChange(engineId: "webllm" | "tjs", enabled: boolean): Promise<void> {
    await runConfigureProvider(this.#intents, {
      providerId: engineId,
      settings: {
        providerName: engineId as ProviderName,
        label: engineId,
        enabled,
      },
    }).promise.catch((err) => {
      console.error(`[ai-config.manager] toggle ${engineId} enabled failed:`, err);
    });
  }

  async #syncWebllmAccordion(): Promise<void> {
    const tab = this.view.webllm;
    let manager: ModelManagerImpl | undefined;
    try {
      manager = this.#workspace.requireAdapter(ModelManager).impl;
    } catch {
      return; // workspace not yet loaded
    }
    if (!manager) return;
    const catalog = manager.store.catalog;

    const search = tab.searchField.value.trim().toLowerCase();
    const familyKeys = [...tab.familyFilter.selectedKeys];
    const familyFilter = familyKeys[0];

    // Group webllm catalog entries by family.
    const families = new Map<string, { catalogKey: string; config: LocalModelConfig }[]>();
    for (const [catalogKey, config] of Object.entries(catalog)) {
      if (config.runtime !== "local" || config.engine !== "webllm") continue;
      const family = config.family;
      const list = families.get(family) ?? [];
      list.push({ catalogKey, config });
      families.set(family, list);
    }

    // Family filter chips.
    const allFamilies = [...families.keys()].sort();
    tab.familyFilter.items = allFamilies.map((f) => ({ key: f, label: f }));

    let visible = [...families.entries()];
    if (familyFilter) {
      visible = visible.filter(([f]) => f === familyFilter);
    }
    if (search) {
      visible = visible.filter(([f, variants]) => {
        if (f.toLowerCase().includes(search)) return true;
        return variants.some((v) => v.config.label.toLowerCase().includes(search));
      });
    }

    if (visible.length === 0) {
      tab.showEmpty();
      return;
    }

    const items = visible.map(([family, variants]) => {
      const downloadedCount = variants.filter((v) => {
        const state = manager?.store.getState(v.catalogKey);
        return state?.status === "downloaded" || state?.status === "ready";
      }).length;
      const stateBadgeLabel =
        downloadedCount > 0
          ? `${downloadedCount}/${variants.length} ready`
          : `${variants.length} variants`;

      const card = new WebllmModelCardView({
        key: `webllm:${family}`,
        family,
        familyIcon: "zap",
        name: family,
        variantCount: variants.length,
        sizeBadgeLabel: variants[0] ? variants[0].config.size : undefined,
      });
      card.setStateBadge(
        stateBadgeLabel,
        downloadedCount === variants.length ? "positive" : "neutral",
      );

      const variantRows = variants.map((v) => this.#makeWebllmVariantRow(v.catalogKey, v.config));

      return {
        key: family,
        title: card,
        content: this.#wrapColumn(`webllm:${family}:body`, variantRows),
      };
    });

    tab.accordion.items = items;
    tab.showAccordion();
  }

  #makeWebllmVariantRow(catalogKey: string, config: { dtype: string }): WebllmVariantRow {
    let manager: ModelManagerImpl | undefined;
    try {
      manager = this.#workspace.requireAdapter(ModelManager).impl;
    } catch {
      // fall through; row is built without live state
    }
    const state = manager?.store.getState(catalogKey);
    const progress = manager?.store.getDownloadProgress?.(catalogKey);
    const status = this.#variantStatusFor(state?.status, Boolean(progress));
    const row = new WebllmVariantRow({
      catalogKey,
      quantization: config.dtype,
      status,
      progress: typeof progress?.progress === "number" ? Math.round(progress.progress * 100) : 0,
    });
    row.downloadAction.onSubmit(() => {
      void runDownloadModel(this.#intents, { catalogKey }).promise.catch((err) => {
        console.error(`[ai-config.manager] download ${catalogKey} failed:`, err);
      });
    });
    row.cancelAction.onSubmit(() => {
      void runCancelDownload(this.#intents, { catalogKey }).promise.catch((err) => {
        console.error(`[ai-config.manager] cancel ${catalogKey} failed:`, err);
      });
    });
    row.removeAction.onSubmit(() => {
      void runDeleteLocalModel(this.#intents, { catalogKey }).promise.catch((err) => {
        console.error(`[ai-config.manager] delete ${catalogKey} failed:`, err);
      });
    });
    return row;
  }

  #variantStatusFor(storeStatus: string | undefined, hasProgress: boolean): VariantStatus {
    if (hasProgress) return "downloading";
    if (storeStatus === "downloaded" || storeStatus === "ready") return "downloaded";
    return "not-downloaded";
  }

  #wrapColumn(key: string, children: WebllmVariantRow[]): FlexView {
    return new FlexView({ key, direction: "column", gap: "0.25rem", children });
  }

  // ── Transformers tab ─────────────────────────────────────────────

  #wireTransformersTab(): void {
    const tab = this.view.transformers;
    this.#register(
      onChange(
        tab.enabledSwitch.onUpdate,
        () => tab.enabledSwitch.isSelected,
        () => void this.#onLocalProviderEnabledChange("tjs", tab.enabledSwitch.isSelected),
      ),
    );
    this.#register(
      onChange(
        tab.searchField.onUpdate,
        () => tab.searchField.value,
        () => void this.#syncTransformersGrid(),
      ),
    );
  }

  async #syncTransformersGrid(): Promise<void> {
    const tab = this.view.transformers;
    let manager: ModelManagerImpl | undefined;
    try {
      manager = this.#workspace.requireAdapter(ModelManager).impl;
    } catch {
      return;
    }
    if (!manager) return;
    const catalog = manager.store.catalog;
    const search = tab.searchField.value.trim().toLowerCase();

    const entries: Array<{ catalogKey: string; config: LocalModelConfig }> = [];
    for (const [catalogKey, config] of Object.entries(catalog)) {
      if (config.runtime !== "local" || config.engine !== "tjs") continue;
      if (search) {
        const hay = `${config.label}\n${config.modelId}\n${config.family}`.toLowerCase();
        if (!hay.includes(search)) continue;
      }
      entries.push({ catalogKey, config });
    }

    if (entries.length === 0) {
      tab.showEmpty();
      return;
    }

    const cards = entries.map(({ catalogKey, config }) => {
      const state = manager?.store.getState(catalogKey);
      const progress = manager?.store.getDownloadProgress?.(catalogKey);
      const status = this.#variantStatusFor(state?.status, Boolean(progress));
      const card = new TransformersModelCardView({
        key: `tjs:${catalogKey}`,
        catalogKey,
        name: config.label,
        hfId: config.modelId,
        status,
        progress: typeof progress?.progress === "number" ? Math.round(progress.progress * 100) : 0,
      });
      card.downloadAction.onSubmit(() => {
        void runDownloadModel(this.#intents, { catalogKey }).promise.catch((err) => {
          console.error(`[ai-config.manager] download ${catalogKey} failed:`, err);
        });
      });
      card.cancelAction.onSubmit(() => {
        void runCancelDownload(this.#intents, { catalogKey }).promise.catch((err) => {
          console.error(`[ai-config.manager] cancel ${catalogKey} failed:`, err);
        });
      });
      card.removeAction.onSubmit(() => {
        void runDeleteLocalModel(this.#intents, { catalogKey }).promise.catch((err) => {
          console.error(`[ai-config.manager] delete ${catalogKey} failed:`, err);
        });
      });
      return card;
    });

    tab.grid.setChildren(cards);
    tab.showGrid();
  }

  // ── runOpen({ focus }) observer ─────────────────────────────────

  #wireOpenFocus(): void {
    this.#register(
      handleOpen(this.#intents, (intent) => {
        const focus = intent.payload?.focus;
        if (focus === "providers") {
          this.view.providersTabs.selectedKey = "remote";
        } else if (focus === "reasoning") {
          this.view.activeModels.reasoningPicker.notify();
        } else if (focus === "embedding") {
          this.view.activeModels.embeddingPicker.notify();
        }
        // Don't claim the intent — the canonical handler in
        // `internal/handlers/open.handler.ts` resolves it after focusing
        // the panel. We're a passive observer.
        return false;
      }),
    );
  }

  // ── Settings menu integration ────────────────────────────────────

  #wireSettingsMenu(): void {
    let mainMenu: MainMenu | undefined;
    try {
      mainMenu = this.#workspace.requireAdapter(MainMenu);
    } catch {
      return; // MainMenu adapter unavailable in this context
    }
    if (!mainMenu) return;

    // Find or create the top-level "Settings" menu container.
    const SETTINGS_KEY = "settings";
    let settings = mainMenu.getAll().find((m) => m.actionKey === SETTINGS_KEY);
    let createdSettingsContainer = false;
    if (!settings) {
      settings = new ActionView({ key: SETTINGS_KEY, label: "Settings", icon: "settings" });
      mainMenu.add(settings);
      createdSettingsContainer = true;
    }
    const settingsContainer = settings;

    // The configurator depends on the workspace's SystemFiles, so the
    // menu item is disabled until the workspace is opened.
    const item = new ActionView({
      key: "ai-providers.menu",
      label: "AI Providers",
      icon: "sparkles",
      disabled: !this.#workspace.isOpened,
    });
    this.#register(
      item.onSubmit(() => {
        // Pass focus: "providers" so the open-handler observer resets
        // the providers tab to "remote" — that gives a visible side
        // effect even when the dock panel is already the focused tab.
        void runOpen(this.#intents, { focus: "providers" }).promise.catch((err) => {
          console.error("[ai-config.manager] runOpen failed:", err);
        });
      }),
    );

    // Toggle disabled state with workspace lifecycle.
    this.#register(
      this.#workspace.onLoad(() => {
        item.disabled = false;
      }),
    );
    this.#register(
      this.#workspace.onUnload(() => {
        item.disabled = true;
      }),
    );

    settingsContainer.children = [...settingsContainer.children, item];
    settingsContainer.notify();
    this.#register(() => {
      settingsContainer.children = settingsContainer.children.filter((c) => c !== item);
      settingsContainer.notify();
      // Remove the Settings container if we created it AND it's now empty.
      if (createdSettingsContainer && settingsContainer.children.length === 0) {
        mainMenu.remove(settingsContainer);
      }
    });
  }

  // ── Keyboard shortcut: Ctrl+M focuses the reasoning picker ───────

  #wireKeyboardShortcut(): void {
    try {
      const keyboard = this.#workspace.requireAdapter(Keyboard);
      this.#register(
        keyboard.bind({
          key: "Ctrl+M",
          execute: () => {
            this.view.activeModels.reasoningPicker.notify();
          },
        }),
      );
    } catch {
      // Keyboard adapter may not be available in all contexts.
    }
  }

  // ── Activation progress (live download progress) ─────────────────
  //
  // Live download progress is reflected via subscribing to
  // `ModelManager.impl.store.onUpdate` in `#subscribeModelManager`.
  // We don't subscribe to the `runActivationProgress` broadcast
  // additionally — it observes the same state via a different surface
  // and can starve the intent loop on rapid progress updates.

  #wireActivationProgress(): void {
    // intentionally empty
  }

  // ── Refresh orchestration ────────────────────────────────────────

  async #refreshAll(): Promise<void> {
    await Promise.all([
      this.#refreshRemoteProviders(),
      this.#syncActivePicker("reasoning"),
      this.#syncActivePicker("embedding"),
      this.#syncWebllmAccordion(),
      this.#syncTransformersGrid(),
    ]);
  }

  async #initialLoad(): Promise<void> {
    await this.#refreshAll();
  }
}
