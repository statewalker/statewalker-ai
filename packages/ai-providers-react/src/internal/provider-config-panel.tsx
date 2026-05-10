import { useCallback } from "react";
import { useAdapterValue } from "@statewalker/core-react";

import {
  type CanonicalCredentials,
  type CanonicalProviderName,
  type CustomProvider,
  Providers,
  type ProvidersConfig,
} from "@statewalker/ai-providers";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@statewalker/shadcn-react";
import { useAdapter } from "@statewalker/core-react";
import { ActiveModelPicker } from "./active-model-picker.js";
import { CanonicalForm } from "./canonical-form.js";
import { CustomProvidersList } from "./custom-providers-list.js";

const CANONICAL_TABS = [
  { name: "openai", label: "OpenAI" },
  { name: "anthropic", label: "Anthropic" },
  { name: "google", label: "Google" },
] as const satisfies ReadonlyArray<{
  name: CanonicalProviderName;
  label: string;
}>;

export function ProviderConfigPanel(): React.ReactElement {
  const providers = useAdapter(Providers);
  const config = useAdapterValue(Providers, (p) => p.config);
  const saveProviders = useCallback(
    (next: ProvidersConfig) => providers.saveProviders(next),
    [providers],
  );

  const setCanonical = useCallback(
    async (
      name: CanonicalProviderName,
      credentials: CanonicalCredentials | null,
    ): Promise<void> => {
      const nextRemote = { ...config.remote };
      let nextActive = { ...config.active };
      if (credentials === null) {
        delete nextRemote[name];
        // If the active provider was this one, clear it.
        if (nextActive.providerId === name) nextActive = {};
      } else {
        nextRemote[name] = credentials;
      }
      await saveProviders({
        ...config,
        remote: nextRemote,
        active: nextActive,
      });
    },
    [config, saveProviders],
  );

  const upsertCustom = useCallback(
    async (entry: CustomProvider): Promise<void> => {
      const idx = config.custom.findIndex((c) => c.id === entry.id);
      const nextCustom =
        idx >= 0
          ? config.custom.map((c, i) => (i === idx ? entry : c))
          : [...config.custom, entry];
      await saveProviders({ ...config, custom: nextCustom });
    },
    [config, saveProviders],
  );

  const removeCustom = useCallback(
    async (id: string): Promise<void> => {
      const nextCustom = config.custom.filter((c) => c.id !== id);
      const nextActive =
        config.active.providerId === id ? {} : { ...config.active };
      await saveProviders({
        ...config,
        custom: nextCustom,
        active: nextActive,
      });
    },
    [config, saveProviders],
  );

  const setActive = useCallback(
    async (
      providerId: string | undefined,
      modelId: string | undefined,
    ): Promise<void> => {
      await saveProviders({ ...config, active: { providerId, modelId } });
    },
    [config, saveProviders],
  );

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <Card>
        <CardHeader>
          <CardTitle>Active model</CardTitle>
          <CardDescription>
            Pick the provider and model used for new chat sessions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActiveModelPicker
            config={config}
            providerId={config.active.providerId}
            modelId={config.active.modelId}
            onChange={setActive}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Providers</CardTitle>
          <CardDescription>
            Credentials are stored as a JSON file inside the workspace. Switch
            workspaces to use different keys.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue={CANONICAL_TABS[0].name}>
            <TabsList className="w-full">
              {CANONICAL_TABS.map((p) => (
                <TabsTrigger key={p.name} value={p.name}>
                  {p.label}
                </TabsTrigger>
              ))}
              <TabsTrigger value="openai-compatible">
                OpenAI-compatible
              </TabsTrigger>
            </TabsList>
            {CANONICAL_TABS.map((p) => (
              <TabsContent key={p.name} value={p.name}>
                <CanonicalForm
                  name={p.name}
                  initial={config.remote[p.name]}
                  onSave={(credentials) => setCanonical(p.name, credentials)}
                  onClear={() => setCanonical(p.name, null)}
                />
              </TabsContent>
            ))}
            <TabsContent value="openai-compatible">
              <CustomProvidersList
                providers={config.custom}
                onSave={upsertCustom}
                onAdd={upsertCustom}
                onDelete={removeCustom}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
