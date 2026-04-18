import { BaseClass } from "@repo/shared/models";
import type {
  DiscoveredModel,
  ProviderName,
  RemoteProviderSettings,
} from "@statewalker/ai-provider";

/** Which step of the Add Remote Provider dialog is visible. */
export type AddProviderStep = "credentials" | "discovered";

export type ConnectionStatus = "idle" | "connecting" | "error";

/** One discovered model with a user-toggleable selection flag. */
export interface SelectableModel extends DiscoveredModel {
  selected: boolean;
}

export type TestConnectionFn = (
  providerType: ProviderName,
  settings: RemoteProviderSettings,
) => Promise<DiscoveredModel[]>;

/**
 * Reactive state for the two-step Add Remote Provider dialog.
 *
 * Step 1 (credentials): user enters providerType + apiKey + baseURL +
 * displayName. Pressing Add triggers `submitAdd()` which calls the
 * injected `testConnection` function, transitioning to step 2 on success
 * or back to step 1 with an error message on failure.
 *
 * Step 2 (discovered): user checks which discovered models to import.
 * Save and Cancel are handled by the controller.
 */
export class AddRemoteProviderFormVM extends BaseClass {
  #providerType: ProviderName = "anthropic";
  #apiKey = "";
  #baseURL = "";
  #displayName = "";

  #step: AddProviderStep = "credentials";
  #status: ConnectionStatus = "idle";
  #error = "";
  #discovered: SelectableModel[] = [];

  readonly #testConnection: TestConnectionFn;

  constructor(testConnection: TestConnectionFn) {
    super();
    this.#testConnection = testConnection;
  }

  // ── Getters ─────────────────────────────────────────────────────

  get providerType(): ProviderName {
    return this.#providerType;
  }
  get apiKey(): string {
    return this.#apiKey;
  }
  get baseURL(): string {
    return this.#baseURL;
  }
  get displayName(): string {
    return this.#displayName;
  }
  get step(): AddProviderStep {
    return this.#step;
  }
  get connectionStatus(): ConnectionStatus {
    return this.#status;
  }
  get connectionError(): string {
    return this.#error;
  }
  get discoveredModels(): readonly SelectableModel[] {
    return this.#discovered;
  }

  /** Step 1 is submittable iff required fields for the provider type are set. */
  get canAdd(): boolean {
    if (this.#status === "connecting") return false;
    if (this.#providerType === "openai-compatible") {
      return (
        this.#baseURL.trim().length > 0 && this.#displayName.trim().length > 0
      );
    }
    return this.#apiKey.trim().length > 0;
  }

  /** Step 2 is submittable iff at least one discovered model is checked. */
  get canSave(): boolean {
    return (
      this.#step === "discovered" && this.#discovered.some((m) => m.selected)
    );
  }

  // ── Setters (user input) ────────────────────────────────────────

  setProviderType(value: ProviderName): void {
    if (this.#providerType === value) return;
    this.#providerType = value;
    // Clear fields that no longer apply.
    if (value !== "openai-compatible") {
      this.#baseURL = "";
      this.#displayName = "";
    }
    this.#error = "";
    this.notify();
  }

  setApiKey(value: string): void {
    if (this.#apiKey === value) return;
    this.#apiKey = value;
    this.#error = "";
    this.notify();
  }

  setBaseURL(value: string): void {
    if (this.#baseURL === value) return;
    this.#baseURL = value;
    this.#error = "";
    this.notify();
  }

  setDisplayName(value: string): void {
    if (this.#displayName === value) return;
    this.#displayName = value;
    this.notify();
  }

  toggleDiscoveredModel(id: string): void {
    const target = this.#discovered.find((m) => m.id === id);
    if (!target) return;
    target.selected = !target.selected;
    this.notify();
  }

  setAllSelected(selected: boolean): void {
    let changed = false;
    for (const m of this.#discovered) {
      if (m.selected !== selected) {
        m.selected = selected;
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  // ── State machine ──────────────────────────────────────────────

  /** Build the settings object passed to `testConnection`. */
  buildSettings(): RemoteProviderSettings {
    const settings: RemoteProviderSettings = {};
    if (this.#apiKey) settings.apiKey = this.#apiKey;
    if (this.#baseURL) settings.baseURL = this.#baseURL;
    return settings;
  }

  /**
   * Press **Add** in step 1. Transitions:
   *   idle → connecting → discovered  (on success)
   *   idle → connecting → credentials + error  (on failure)
   * Returns `true` if the call succeeded, `false` otherwise.
   */
  async submitAdd(): Promise<boolean> {
    if (!this.canAdd) return false;
    this.#status = "connecting";
    this.#error = "";
    this.notify();
    try {
      const models = await this.#testConnection(
        this.#providerType,
        this.buildSettings(),
      );
      this.#discovered = models.map((m) => ({ ...m, selected: true }));
      this.#status = "idle";
      this.#step = "discovered";
      this.notify();
      return true;
    } catch (err) {
      this.#status = "error";
      this.#error = err instanceof Error ? err.message : String(err);
      // Stay on step 1 so the user can edit and retry.
      this.#step = "credentials";
      this.notify();
      return false;
    }
  }

  /** Reset to step 1 (used by the controller after Save or Cancel from step 2). */
  reset(): void {
    this.#step = "credentials";
    this.#status = "idle";
    this.#error = "";
    this.#discovered = [];
    this.notify();
  }

  /** The selected discovered models — consumed by Save. */
  getSelectedDiscovered(): DiscoveredModel[] {
    return this.#discovered
      .filter((m) => m.selected)
      .map((m) => ({ id: m.id, label: m.label }));
  }
}
