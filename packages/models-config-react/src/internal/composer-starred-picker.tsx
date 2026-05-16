import {
  type Connection,
  Providers,
  SelectActiveModelCommand,
  type StarredRef,
} from "@statewalker/ai-providers";
import { useAdapter, useAdapterValue } from "@statewalker/core-react";
import { ManageRemoteConnectionsCommand, SelectModelCommand } from "@statewalker/models-config";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@statewalker/shadcn-react";
import { Commands } from "@statewalker/shared-commands";
import { type ReactElement, useMemo } from "react";

const NO_MODELS = "__no-models__";
const ALL_MODELS = "__all-models__";
const MANAGE_CONNECTIONS = "__manage-connections__";

interface ChoiceRow {
  value: string;
  connectionId: string;
  modelId: string;
  label: string;
  providerLabel: string;
}

function findConnectionLabel(connections: Connection[], id: string): string {
  return connections.find((c) => c.id === id)?.name ?? id;
}

function buildChoices(connections: Connection[], starred: StarredRef[]): ChoiceRow[] {
  return starred.map((s) => ({
    value: `${s.connectionId}::${s.modelId}`,
    connectionId: s.connectionId,
    modelId: s.modelId,
    label: s.modelId,
    providerLabel: findConnectionLabel(connections, s.connectionId),
  }));
}

/**
 * Compact model picker rendered in the chat composer's leading
 * actions row. Reads `Providers.config.starred` reactively and shows
 * one entry per starred model. The trailing "All models…" entry
 * fires `SelectModelCommand` (opens the Models List dialog).
 *
 * Empty-state paths:
 * - No connections at all → "Configure connections…" button.
 * - Connections exist but no starred entries → a single "All
 *   models…" entry.
 */
export function ComposerStarredPicker(): ReactElement {
  const commands = useAdapter(Commands);
  // Read the stable `config` reference directly — a fresh-object
  // selector returns a new shape on every render and triggers
  // useSyncExternalStore's infinite-update guard. `config` itself
  // is reference-equal between Providers notifications, so it's a
  // safe snapshot.
  const config = useAdapterValue(Providers, (p) => p.config);
  const { connections, starred, active } = config;

  const choices = useMemo(
    () => buildChoices(connections, starred),
    [connections, starred],
  );
  const activeValue =
    active.providerId && active.modelId
      ? `${active.providerId}::${active.modelId}`
      : "";

  // No connections at all — loud CTA so the first-run user finds
  // the configuration entry point without having to dig through
  // Settings.
  if (connections.length === 0) {
    return (
      <button
        type="button"
        className="rounded-md border border-primary bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20"
        onClick={() => {
          void commands.call(ManageRemoteConnectionsCommand, undefined);
        }}
      >
        Add a connection…
      </button>
    );
  }

  return (
    <Select
      value={activeValue || NO_MODELS}
      onValueChange={(next) => {
        if (next === MANAGE_CONNECTIONS) {
          void commands.call(ManageRemoteConnectionsCommand, undefined);
          return;
        }
        if (next === ALL_MODELS) {
          void commands.call(SelectModelCommand, undefined);
          return;
        }
        if (next === NO_MODELS) return;
        const [connectionId, modelId] = next.split("::");
        if (!connectionId || !modelId) return;
        void commands.call(SelectActiveModelCommand, {
          providerId: connectionId,
          modelId,
        });
      }}
    >
      <SelectTrigger className="h-8 min-w-[10rem] border-0 bg-transparent px-2 text-xs hover:bg-accent">
        <SelectValue placeholder="Pick a model…" />
      </SelectTrigger>
      <SelectContent>
        {choices.length === 0 ? (
          <SelectItem value={NO_MODELS} disabled>
            <span className="text-xs text-muted-foreground">No starred models yet</span>
          </SelectItem>
        ) : (
          choices.map((c) => (
            <SelectItem key={c.value} value={c.value}>
              <span className="font-medium">{c.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">{c.providerLabel}</span>
            </SelectItem>
          ))
        )}
        <SelectItem value={ALL_MODELS}>
          <span className="text-xs text-muted-foreground">All models…</span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
