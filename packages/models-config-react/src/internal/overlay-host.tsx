import { createStateStore, type StateStore } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { Providers } from "@statewalker/ai-providers";
import { useAppWorkspace } from "@statewalker/core-react";
import {
  LocalModels,
  ManageLocalModelsCommand,
  ManageRemoteConnectionsCommand,
  makeInitialState,
  makeModelsConfigSpec,
  SelectModelCommand,
} from "@statewalker/models-config";
import { Commands } from "@statewalker/shared-commands";
import { type ReactElement, useEffect, useMemo } from "react";
import { buildActionHandlers } from "./action-handlers.js";
import { buildModelsConfigRegistry } from "./build-react-catalog.js";
import { bindPersistent } from "./state-bridge.js";

/**
 * Host for the three-Dialog json-render spec. Mounted by the
 * `dock:overlays` viewKey contribution from `models-config`. Creates
 * a controlled `StateStore`, wires the persistent-state subscription
 * and the three open-dialog command listeners, builds the action
 * handlers, and mounts `<JSONUIProvider>` + `<Renderer>`.
 */
export function ModelsConfigOverlayHost(): ReactElement {
  const workspace = useAppWorkspace();
  const providers = workspace.requireAdapter(Providers);
  const localModels = workspace.requireAdapter(LocalModels);
  const commands = workspace.requireAdapter(Commands);

  // Store + spec are stable per mount.
  const store: StateStore = useMemo(() => createStateStore(makeInitialState()), []);
  const spec = useMemo(() => makeModelsConfigSpec(), []);
  const actionHandlers = useMemo(
    () => buildActionHandlers({ workspace, store }),
    [workspace, store],
  );
  const registry = useMemo(
    () => buildModelsConfigRegistry({ actions: actionHandlers }).registry,
    [actionHandlers],
  );

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    cleanups.push(bindPersistent(store, providers, localModels));
    cleanups.push(
      commands.listen(SelectModelCommand, (cmd) => {
        store.set("/ui/dialogs/modelsList/open", true);
        cmd.resolve();
        return true;
      }),
    );
    cleanups.push(
      commands.listen(ManageRemoteConnectionsCommand, (cmd) => {
        store.set("/ui/dialogs/remoteConnections/open", true);
        cmd.resolve();
        return true;
      }),
    );
    cleanups.push(
      commands.listen(ManageLocalModelsCommand, (cmd) => {
        store.set("/ui/dialogs/localModels/open", true);
        cmd.resolve();
        return true;
      }),
    );
    return () => {
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          /* best-effort */
        }
      }
    };
  }, [store, providers, localModels, commands]);

  return (
    <JSONUIProvider registry={registry} store={store}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}
