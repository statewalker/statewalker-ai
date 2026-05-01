import {
  ActionView,
  BadgeView,
  ButtonView,
  CardView,
  DividerView,
  EmptyView,
  FlexView,
  GridView,
  HeadingView,
  InlineAlertView,
  ScrollAreaView,
  SearchFieldView,
  TextFieldView,
  ToggleButtonView,
  ToggleGroupView,
} from "@statewalker/workbench-views";
import type { ConnectionStatus } from "./providers.types.js";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  untested: "Untested",
  testing: "Testing…",
  connected: "Connected",
  failed: "Failed",
};

const STATUS_VARIANT: Record<
  ConnectionStatus,
  "neutral" | "informative" | "positive" | "negative"
> = {
  untested: "neutral",
  testing: "informative",
  connected: "positive",
  failed: "negative",
};

export interface RemoteProviderFormOptions {
  key: string;
  providerName: string;
  isCompatible?: boolean;
}

export class RemoteProviderFormView extends CardView {
  readonly heading: HeadingView;
  readonly statusBadge: BadgeView;
  readonly selectedCountBadge: BadgeView;
  readonly apiKeyField: TextFieldView;
  readonly revealAction: ActionView;
  readonly revealToggle: ToggleButtonView;
  readonly testAction: ActionView;
  readonly testButton: ButtonView;
  readonly endpointField: TextFieldView;
  readonly errorAlert: InlineAlertView;
  readonly searchField: SearchFieldView;
  readonly capabilityFilter: ToggleGroupView;
  readonly modelsScrollArea: ScrollAreaView;
  readonly modelsGrid: GridView;
  readonly disconnectedEmpty: EmptyView;
  readonly modelsSection: FlexView;
  readonly isCompatible: boolean;

  #connectionStatus: ConnectionStatus = "untested";

  constructor(options: RemoteProviderFormOptions) {
    const heading = new HeadingView({
      key: `${options.key}:heading`,
      text: options.providerName,
      level: 3,
    });
    const statusBadge = new BadgeView({
      key: `${options.key}:status`,
      label: STATUS_LABEL.untested,
      variant: STATUS_VARIANT.untested,
    });
    const selectedCountBadge = new BadgeView({
      key: `${options.key}:selected-count`,
      label: "0 selected",
      variant: "neutral",
    });
    const headerRow = new FlexView({
      key: `${options.key}:header`,
      direction: "row",
      gap: "0.5rem",
      children: [heading, statusBadge, selectedCountBadge],
    });

    const apiKeyField = new TextFieldView({
      key: `${options.key}:api-key`,
      label: "API key",
      type: "password",
    });
    const revealAction = new ActionView({
      key: `${options.key}:reveal`,
      icon: "eye",
      label: "Show",
    });
    const revealToggle = new ToggleButtonView({
      key: `${options.key}:reveal-toggle`,
      action: revealAction,
    });
    const testAction = new ActionView({
      key: `${options.key}:test`,
      label: "Test connection",
    });
    const testButton = new ButtonView({
      key: `${options.key}:test-btn`,
      action: testAction,
    });
    const apiKeyRow = new FlexView({
      key: `${options.key}:api-key-row`,
      direction: "row",
      gap: "0.5rem",
      children: [apiKeyField, revealToggle, testButton],
    });

    const endpointField = new TextFieldView({
      key: `${options.key}:endpoint`,
      label: "Endpoint URL",
      type: "url",
    });
    const errorAlert = new InlineAlertView({
      key: `${options.key}:error`,
      variant: "negative",
      content: "",
    });

    const divider = new DividerView({ key: `${options.key}:divider` });

    const searchField = new SearchFieldView({
      key: `${options.key}:search`,
      placeholder: "Search models…",
    });
    const capabilityFilter = new ToggleGroupView({
      key: `${options.key}:cap-filter`,
      type: "single",
      items: [
        { key: "all", label: "All" },
        { key: "reasoning", label: "Reasoning" },
        { key: "embedding", label: "Embedding" },
      ],
      selectedKeys: ["all"],
    });
    const modelsGrid = new GridView({
      key: `${options.key}:models-grid`,
      columns: "repeat(auto-fill, minmax(280px, 1fr))",
      gap: "0.75rem",
    });
    const modelsScrollArea = new ScrollAreaView({
      key: `${options.key}:models-scroll`,
      maxHeight: "400px",
      children: [modelsGrid],
    });
    const disconnectedEmpty = new EmptyView({
      key: `${options.key}:disconnected`,
      icon: "cloud-off",
      heading: "Enter API key and test connection to see available models",
    });
    const modelsSection = new FlexView({
      key: `${options.key}:models-section`,
      direction: "column",
      gap: "0.5rem",
      children: [searchField, capabilityFilter, disconnectedEmpty],
    });

    const children = options.isCompatible
      ? [apiKeyRow, endpointField, errorAlert, divider, modelsSection]
      : [apiKeyRow, errorAlert, divider, modelsSection];

    super({
      key: options.key,
      header: headerRow,
      children,
    });

    this.heading = heading;
    this.statusBadge = statusBadge;
    this.selectedCountBadge = selectedCountBadge;
    this.apiKeyField = apiKeyField;
    this.revealAction = revealAction;
    this.revealToggle = revealToggle;
    this.testAction = testAction;
    this.testButton = testButton;
    this.endpointField = endpointField;
    this.errorAlert = errorAlert;
    this.searchField = searchField;
    this.capabilityFilter = capabilityFilter;
    this.modelsScrollArea = modelsScrollArea;
    this.modelsGrid = modelsGrid;
    this.disconnectedEmpty = disconnectedEmpty;
    this.modelsSection = modelsSection;
    this.isCompatible = Boolean(options.isCompatible);
  }

  get connectionStatus(): ConnectionStatus {
    return this.#connectionStatus;
  }

  setConnectionStatus(status: ConnectionStatus): void {
    this.#connectionStatus = status;
    this.statusBadge.label = STATUS_LABEL[status];
    this.statusBadge.variant = STATUS_VARIANT[status];
    if (status === "connected") {
      this.modelsSection.setChildren([
        this.searchField,
        this.capabilityFilter,
        this.modelsScrollArea,
      ]);
    } else {
      this.modelsSection.setChildren([
        this.searchField,
        this.capabilityFilter,
        this.disconnectedEmpty,
      ]);
    }
  }

  setSelectedCount(count: number): void {
    this.selectedCountBadge.label = `${count} selected`;
  }
}
