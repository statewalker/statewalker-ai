import { createStateStore, type StateStore } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { type Connection, isConnected, Providers } from "@statewalker/ai-providers";
import { useAdapterValue, useAppWorkspace } from "@statewalker/core-react";
import {
  capabilitiesFor,
  makeConnectionsTabInitialState,
  makeConnectionsTabSpec,
} from "@statewalker/models-config";
import { type ReactElement, useEffect, useMemo } from "react";
import { buildActionHandlers } from "./action-handlers.js";
import { buildModelsConfigRegistry } from "./build-react-catalog.js";

interface ConnectionViewRow {
  id: string;
  name: string;
  type: string;
  url?: string;
  connected: boolean;
  models: Array<{
    id: string;
    label: string;
    starred: boolean;
    capabilities: string;
  }>;
}

function projectConnection(c: Connection): ConnectionViewRow {
  const starredSet = new Set(c.starredModelIds);
  const discovered = c.discoveredModels ?? [];
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    url: c.url,
    connected: isConnected(c),
    models: discovered.map((m) => {
      const caps = m.capabilities ?? capabilitiesFor(m.id);
      return {
        id: m.id,
        label: m.label,
        starred: starredSet.has(m.id),
        capabilities: caps.join(", "),
      };
    }),
  };
}

function projectByType(connections: readonly Connection[]): Record<string, ConnectionViewRow[]> {
  const out: Record<string, ConnectionViewRow[]> = {
    google: [],
    openai: [],
    anthropic: [],
    "openai-compatible": [],
  };
  for (const c of connections) {
    let bucket = out[c.type];
    if (!bucket) {
      bucket = [];
      out[c.type] = bucket;
    }
    bucket.push(projectConnection(c));
  }
  return out;
}

/**
 * Renders the Settings dialog's "Models & Connections" tab body —
 * the 4-tab Connections form (Google / OpenAI / Anthropic /
 * OpenAI-compatible) with per-Connection model lists and lifecycle
 * verbs. Mounted via `settings:tabs` (replaces the retired
 * `dock:overlays` overlay host).
 */
export function ModelsConfigConnectionsTab(): ReactElement {
  const workspace = useAppWorkspace();

  // Stable store + spec per mount.
  const store: StateStore = useMemo(() => createStateStore(makeConnectionsTabInitialState()), []);
  const spec = useMemo(() => makeConnectionsTabSpec(), []);
  const actionHandlers = useMemo(
    () => buildActionHandlers({ workspace, store }),
    [workspace, store],
  );
  const registry = useMemo(
    () => buildModelsConfigRegistry({ actions: actionHandlers }).registry,
    [actionHandlers],
  );

  const connections = useAdapterValue(Providers, (p) => p.config.connections);
  useEffect(() => {
    store.set("/persistent/connectionsByType", projectByType(connections));
  }, [store, connections]);

  return (
    <JSONUIProvider registry={registry} store={store} handlers={actionHandlers}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}
