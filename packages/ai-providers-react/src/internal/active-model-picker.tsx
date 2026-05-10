import {
  createDefaultCatalog,
  type ModelConfig,
} from "@statewalker/ai-agent/models";
import { useMemo } from "react";
import {
  type CanonicalProviderName,
  canonicalLabel,
  listConfiguredProviders,
  type ProvidersConfig,
} from "@statewalker/ai-providers";
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@statewalker/shadcn-react";

interface CatalogModel {
  modelId: string;
  label: string;
}

function listCanonicalModels(provider: CanonicalProviderName): CatalogModel[] {
  const catalog = createDefaultCatalog();
  const out: CatalogModel[] = [];
  for (const entry of Object.values(catalog) as ModelConfig[]) {
    if (entry.runtime !== "remote") continue;
    if (entry.provider !== provider) continue;
    out.push({ modelId: entry.modelId, label: entry.label ?? entry.modelId });
  }
  return out;
}

export interface ActiveModelPickerProps {
  config: ProvidersConfig;
  providerId: string | undefined;
  modelId: string | undefined;
  onChange: (
    providerId: string | undefined,
    modelId: string | undefined,
  ) => void;
}

export function ActiveModelPicker({
  config,
  providerId,
  modelId,
  onChange,
}: ActiveModelPickerProps): React.ReactElement {
  const configured = useMemo(() => listConfiguredProviders(config), [config]);

  if (configured.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Save credentials for at least one provider to enable the model picker.
      </p>
    );
  }

  const active = configured.find((p) => p.id === providerId);
  const isCanonical = active?.kind === "canonical";
  const canonicalModels = isCanonical
    ? listCanonicalModels(active.providerName as CanonicalProviderName)
    : [];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label>Provider</Label>
        <Select
          value={providerId ?? ""}
          onValueChange={(next) => onChange(next || undefined, undefined)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Pick a provider…" />
          </SelectTrigger>
          <SelectContent>
            {configured.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="font-medium">{p.label}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {p.kind === "canonical"
                    ? canonicalLabel(p.providerName as CanonicalProviderName)
                    : "OpenAI-compatible"}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Model</Label>
        {isCanonical ? (
          <Select
            value={modelId ?? ""}
            onValueChange={(next) => onChange(providerId, next || undefined)}
            disabled={!providerId}
          >
            <SelectTrigger>
              <SelectValue placeholder="Pick a model…" />
            </SelectTrigger>
            <SelectContent>
              {canonicalModels.map((m) => (
                <SelectItem key={m.modelId} value={m.modelId}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            placeholder={
              providerId
                ? "Model ID (e.g. llama-3.1-8b-instruct)"
                : "Pick a provider first"
            }
            value={modelId ?? ""}
            disabled={!providerId}
            onChange={(e) => onChange(providerId, e.target.value || undefined)}
          />
        )}
      </div>
    </div>
  );
}
