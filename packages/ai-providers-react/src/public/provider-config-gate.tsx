import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@statewalker/shadcn-react";
import { ProviderConfigPanel } from "../internal/provider-config-panel.js";

/**
 * Full-pane variant shown in the main shell while no model is active. Reuses
 * the same forms as the always-on settings panel but inside a card with a
 * gating headline.
 */
export function ProviderConfigGate(): React.ReactElement {
  return (
    <div className="flex h-full w-full flex-col">
      <Card className="m-6">
        <CardHeader>
          <CardTitle>Configure a provider to start chatting</CardTitle>
          <CardDescription>
            Add an API key for one of the supported providers and pick a model
            to enable the chat surface.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ProviderConfigPanel />
        </CardContent>
      </Card>
    </div>
  );
}
