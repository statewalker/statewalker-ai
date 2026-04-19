import { BaseClass } from "@repo/shared-baseclass";
import type {
  ActivationProgress,
  LocalModelConfig,
  ModelState,
} from "@statewalker/ai-provider";

/** One local catalog entry shown in the picker. */
export interface LocalCatalogEntry {
  key: string;
  label: string;
  family: string;
  size: string;
  /** `true` when the weights are already on disk. */
  alreadyDownloaded: boolean;
}

export type DownloadPhase =
  | "idle"
  | "downloading"
  | "downloaded"
  | "error"
  | "cancelled";

/**
 * Reactive state for the Add Local Model dialog: picker + download
 * progress. Defaults `selectedKey` to the first Gemma entry, falling
 * back to the first catalog entry when no Gemma is available.
 */
export class AddLocalModelFormVM extends BaseClass {
  readonly #catalog: LocalCatalogEntry[];
  #selectedKey: string | undefined;

  #phase: DownloadPhase = "idle";
  #progress = 0;
  #message = "";
  #errorMessage = "";

  constructor(catalog: LocalCatalogEntry[]) {
    super();
    this.#catalog = catalog;
    this.#selectedKey = pickDefault(catalog);
  }

  /** Build a catalog snapshot from the state map + status lookup. */
  static fromStates(
    states: ReadonlyMap<string, ModelState>,
  ): AddLocalModelFormVM {
    const catalog: LocalCatalogEntry[] = [];
    for (const [key, state] of states) {
      if (state.config.runtime !== "local") continue;
      const c = state.config as LocalModelConfig;
      catalog.push({
        key,
        label: c.label,
        family: c.family,
        size: c.size,
        alreadyDownloaded:
          state.status === "downloaded" || state.status === "ready",
      });
    }
    catalog.sort(
      (a, b) =>
        a.family.localeCompare(b.family) || a.label.localeCompare(b.label),
    );
    return new AddLocalModelFormVM(catalog);
  }

  get catalog(): readonly LocalCatalogEntry[] {
    return this.#catalog;
  }

  get selectedKey(): string | undefined {
    return this.#selectedKey;
  }

  get selectedEntry(): LocalCatalogEntry | undefined {
    return this.#catalog.find((e) => e.key === this.#selectedKey);
  }

  get downloadPhase(): DownloadPhase {
    return this.#phase;
  }

  get progress(): number {
    return this.#progress;
  }

  get message(): string {
    return this.#message;
  }

  get errorMessage(): string {
    return this.#errorMessage;
  }

  /** Download is allowed when something is selected and no download in flight. */
  get canDownload(): boolean {
    if (this.#phase === "downloading") return false;
    const entry = this.selectedEntry;
    if (!entry) return false;
    return !entry.alreadyDownloaded;
  }

  setSelectedKey(key: string): void {
    if (this.#selectedKey === key) return;
    this.#selectedKey = key;
    this.#phase = "idle";
    this.#progress = 0;
    this.#message = "";
    this.#errorMessage = "";
    this.notify();
  }

  // ── Phase transitions (called by the controller wrapping manager.download) ──

  beginDownload(): void {
    this.#phase = "downloading";
    this.#progress = 0;
    this.#message = "";
    this.#errorMessage = "";
    this.notify();
  }

  applyProgress(p: ActivationProgress): void {
    this.#progress = p.progress ?? this.#progress;
    this.#message = p.message;
    this.notify();
  }

  completeDownload(): void {
    this.#phase = "downloaded";
    this.#progress = 1;
    this.#message = "Download complete";
    this.notify();
  }

  failDownload(error: string): void {
    this.#phase = "error";
    this.#errorMessage = error;
    this.notify();
  }

  cancelDownload(): void {
    this.#phase = "cancelled";
    this.notify();
  }
}

function pickDefault(catalog: LocalCatalogEntry[]): string | undefined {
  const gemma = catalog.find((e) => /gemma/i.test(e.family));
  return (gemma ?? catalog[0])?.key;
}
