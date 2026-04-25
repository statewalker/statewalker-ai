import {
  ActionView,
  ButtonView,
  MenuItemView,
  MenuTriggerView,
  MenuView,
  TextView,
  ViewModel,
} from "@statewalker/workbench-views";

export type ModelPickerMode = "none" | "single" | "multi";

export interface PickerModelItem {
  key: string;
  label: string;
  provider: string;
  isActive: boolean;
  isInteractive: boolean;
  statusReason?: string;
}

/**
 * Composed AI-model picker for the chat header.
 *
 * Owns one of three primitive views (`ButtonView`, `TextView`,
 * `MenuTriggerView`) and exposes the active one as `current`. Consumers
 * render `picker.current` through the shared component registry —
 * because the underlying primitives already have renderers in every
 * design-system package (workbench-react-shadcn / -spectrum), no
 * AI-specific renderer is needed.
 *
 * Mode → current view:
 *   - "none"   → ButtonView (`Configure model…`); click opens settings.
 *   - "single" → TextView (read-only label of the active model).
 *   - "multi"  → MenuTriggerView (dropdown listing every active
 *                reasoning model + a `Manage Models…` entry).
 */
export class ModelPickerView extends ViewModel {
  // External state read by chat-ui to gate input.
  #mode: ModelPickerMode = "none";
  get mode(): ModelPickerMode {
    return this.#mode;
  }

  #items: PickerModelItem[] = [];
  get items(): PickerModelItem[] {
    return this.#items;
  }

  #currentKey = "";
  get currentKey(): string {
    return this.#currentKey;
  }

  #currentLabel = "";
  get currentLabel(): string {
    return this.#currentLabel;
  }

  #isActivating = false;
  get isActivating(): boolean {
    return this.#isActivating;
  }

  #activationMessage = "";
  get activationMessage(): string {
    return this.#activationMessage;
  }

  // Wired actions controllers can subscribe to.
  readonly configureAction: ActionView;
  readonly manageAction: ActionView;
  readonly selectAction: ActionView<string>;

  // Composed primitives. Each represents one mode; we keep them
  // around so subscriptions stay stable across mode flips.
  readonly #configureButton: ButtonView;
  readonly #singleLabel: TextView;
  readonly #menuTrigger: MenuTriggerView;
  readonly #menu: MenuView;
  readonly #manageItem: MenuItemView;

  #current: ViewModel;
  get current(): ViewModel {
    return this.#current;
  }

  constructor(options?: { key?: string }) {
    super({ key: options?.key });

    this.configureAction = new ActionView({
      key: "configure",
      label: "Configure model…",
      variant: "neutral",
    });
    this.manageAction = new ActionView({
      key: "manage",
      label: "Manage Models…",
    });
    this.selectAction = new ActionView<string>({ key: "select" });

    this.#configureButton = new ButtonView({ action: this.configureAction });
    this.#singleLabel = new TextView({ text: "" });

    const triggerAction = new ActionView({
      key: "model-trigger",
      label: "Pick a model",
    });
    this.#menu = new MenuView({ children: [] });
    this.#manageItem = new MenuItemView({ action: this.manageAction });
    this.#menuTrigger = new MenuTriggerView({
      trigger: triggerAction,
      menu: this.#menu,
    });

    this.#current = this.#configureButton;
  }

  /** No reasoning models active — show "Configure model…" button. */
  setNoneMode(): void {
    this.#mode = "none";
    this.#items = [];
    this.#currentKey = "";
    this.#currentLabel = "";
    this.#current = this.#configureButton;
    this.notify();
  }

  /** Exactly one reasoning model active — show a static label. */
  setSingleMode(items: PickerModelItem[], currentKey: string, currentLabel: string): void {
    this.#mode = "single";
    this.#items = items;
    this.#currentKey = currentKey;
    this.#currentLabel = currentLabel;
    this.#singleLabel.text = currentLabel;
    this.#current = this.#singleLabel;
    this.notify();
  }

  /** ≥ 2 reasoning models active — show a dropdown. */
  setMultiMode(items: PickerModelItem[], currentKey: string, currentLabel: string): void {
    this.#mode = "multi";
    this.#items = items;
    this.#currentKey = currentKey;
    this.#currentLabel = currentLabel;

    const menuItems = items.map(
      (item) =>
        new MenuItemView({
          action: new ActionView({
            key: item.key,
            label: item.label,
            execute: () => this.selectAction.submit(item.key),
          }),
        }),
    );
    menuItems.push(
      new MenuItemView({ action: new ActionView({ key: "_sep" }), isSeparator: true }),
    );
    menuItems.push(this.#manageItem);
    this.#menu.setChildren(menuItems);

    (this.#menuTrigger.trigger as ActionView).label = currentLabel || "Pick a model";

    this.#current = this.#menuTrigger;
    this.notify();
  }

  setActivationState(isActivating: boolean, activationMessage = ""): void {
    if (this.#isActivating === isActivating && this.#activationMessage === activationMessage) {
      return;
    }
    this.#isActivating = isActivating;
    this.#activationMessage = activationMessage;
    if (this.#mode === "single") {
      this.#singleLabel.text = isActivating ? activationMessage : this.#currentLabel;
    } else if (this.#mode === "multi") {
      (this.#menuTrigger.trigger as ActionView).label = isActivating
        ? activationMessage
        : this.#currentLabel || "Pick a model";
    }
    this.notify();
  }
}
