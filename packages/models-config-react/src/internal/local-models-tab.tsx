import { createStateStore, type StateStore } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { Providers } from "@statewalker/ai-providers";
import { useAppWorkspace } from "@statewalker/core-react";
import {
  LocalModels,
  makeLocalModelsTabInitialState,
  makeLocalModelsTabSpec,
} from "@statewalker/models-config";
import { type ReactElement, useEffect, useMemo } from "react";
import { buildActionHandlers } from "./action-handlers.js";
import { buildModelsConfigRegistry } from "./build-react-catalog.js";
import { bindLocalModels } from "./state-bridge.js";

/**
 * Renders the Settings dialog's "Local Models" tab body. Mounted via
 * `settings:tabs`. Owns its own `StateStore`; mirrors
 * `Providers.config.local` and `LocalModels` adapter state through
 * `bindLocalModels`.
 */
export function ModelsConfigLocalTab(): ReactElement {
  const workspace = useAppWorkspace();
  const providers = workspace.requireAdapter(Providers);
  const localModels = workspace.requireAdapter(LocalModels);

  const store: StateStore = useMemo(() => createStateStore(makeLocalModelsTabInitialState()), []);
  const spec = useMemo(() => makeLocalModelsTabSpec(), []);
  const actionHandlers = useMemo(
    () => buildActionHandlers({ workspace, store }),
    [workspace, store],
  );
  const registry = useMemo(
    () => buildModelsConfigRegistry({ actions: actionHandlers }).registry,
    [actionHandlers],
  );

  useEffect(() => {
    return bindLocalModels(store, providers, localModels);
  }, [store, providers, localModels]);

  return (
    <JSONUIProvider registry={registry} store={store} handlers={actionHandlers}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}
