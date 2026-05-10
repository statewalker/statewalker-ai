import {
  createDefaultCatalog,
  type ModelConfig,
} from "@statewalker/ai-agent/models";
import { Intents } from "@statewalker/shared-intents";
import { type ReactElement, useMemo } from "react";
import { useAdapterValue } from "@statewalker/core-react";
import {
  type CanonicalProviderName,
  canonicalLabel,
  listConfiguredProviders,
  Providers,
  type ProvidersConfig,
  runOpenProviderConfig,
  runSelectActiveModel,
} from "@statewalker/ai-providers";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@statewalker/shadcn-react";
import { useAdapter } from "@statewalker/core-react";

interface FlatChoice {
  /** "providerId::modelId" — encoded so we can round-trip through the Select. */
  value: string;
  providerId: string;
  modelId: string;
  label: string;
  providerLabel: string;
}

const NO_MODELS_VALUE = "__no-models__";
const CONFIGURE_VALUE = "__configure__";

function flatChoicesFor(config: ProvidersConfig): FlatChoice[] {
  const configured = listConfiguredProviders(config);
  const catalog = createDefaultCatalog();
  const out: FlatChoice[] = [];
  for (const p of configured) {
    if (p.kind === "canonical") {
      for (const entry of Object.values(catalog) as ModelConfig[]) {
        if (entry.runtime !== "remote") continue;
        if (entry.provider !== (p.providerName as CanonicalProviderName))
          continue;
        out.push({
          value: `${p.id}::${entry.modelId}`,
          providerId: p.id,
          modelId: entry.modelId,
          label: entry.label ?? entry.modelId,
          providerLabel: canonicalLabel(
            p.providerName as CanonicalProviderName,
          ),
        });
      }
    }
    // Custom providers don't have a known model catalog — picking a
    // model for them happens in the settings dialog (free-text input).
    // The composer picker only lists canonical-provider models for now.
  }
  return out;
}

/**
 * Compact model picker rendered in the chat composer's actions row.
 * Reads `Providers.config.active` reactively, presents a flat list
 * of "Provider · Model" entries for canonical providers, and fires
 * `providers:select-active-model` on change.
 *
 * When no provider is configured, falls back to a "Configure
 * providers…" affordance that opens the settings dialog. Custom
 * (OpenAI-compatible) provider model selection lives in the
 * settings dialog (free-text input), not here.
 */
export function ComposerModelPicker(): ReactElement {
  const intents = useAdapter(Intents);
  const config = useAdapterValue(Providers, (p) => p.config);

  const choices = useMemo(() => flatChoicesFor(config), [config]);
  const active = config.active;
  const activeValue =
    active.providerId && active.modelId
      ? `${active.providerId}::${active.modelId}`
      : "";

  if (choices.length === 0) {
    return (
      <button
        type="button"
        className="rounded-md border border-dashed border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
        onClick={() => {
          runOpenProviderConfig(intents);
        }}
      >
        Configure providers…
      </button>
    );
  }

  return (
    <Select
      value={activeValue || NO_MODELS_VALUE}
      onValueChange={(next) => {
        if (next === CONFIGURE_VALUE) {
          runOpenProviderConfig(intents);
          return;
        }
        if (next === NO_MODELS_VALUE) return;
        const [providerId, modelId] = next.split("::");
        if (!providerId || !modelId) return;
        runSelectActiveModel(intents, { providerId, modelId });
      }}
    >
      <SelectTrigger className="h-8 min-w-[10rem] border-0 bg-transparent px-2 text-xs hover:bg-accent">
        <SelectValue placeholder="Pick a model…" />
      </SelectTrigger>
      <SelectContent>
        {choices.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            <span className="font-medium">{c.label}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {c.providerLabel}
            </span>
          </SelectItem>
        ))}
        <SelectItem value={CONFIGURE_VALUE}>
          <span className="text-xs text-muted-foreground">
            Configure providers…
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
