import { useChatPanelContext } from "@repo/chat-mini.chat-react";
import { AgentRuntimeAdapter } from "@statewalker/ai-agent-runtime";
import {
  type Connection,
  isConnected,
  Providers,
  SelectActiveModelCommand,
} from "@statewalker/ai-providers";
import { useAdapter, useAdapterValue, useAppWorkspace } from "@statewalker/core-react";
import { ConfigureModelsCommand, capabilitiesFor } from "@statewalker/models-config";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@statewalker/shadcn-react";
import { Commands } from "@statewalker/shared-commands";
import { type ReactElement, useEffect, useMemo, useState } from "react";

const NO_MODELS = "__no-models__";
const CONFIGURE = "__configure__";

interface ChoiceRow {
  value: string;
  connectionId: string;
  modelId: string;
  label: string;
  providerLabel: string;
}

/** Build the dropdown list: union of (connection, modelId) across
 * connected Connections, filtered by `chat` capability. */
function buildChoices(connections: readonly Connection[]): ChoiceRow[] {
  const out: ChoiceRow[] = [];
  for (const c of connections) {
    if (!isConnected(c)) continue;
    for (const modelId of c.starredModelIds) {
      if (!capabilitiesFor(modelId).includes("chat")) continue;
      out.push({
        value: `${c.id}::${modelId}`,
        connectionId: c.id,
        modelId,
        label: modelId,
        providerLabel: c.name,
      });
    }
  }
  return out;
}

function findConnection(
  connections: readonly Connection[],
  id: string | undefined,
): Connection | undefined {
  return id ? connections.find((c) => c.id === id) : undefined;
}

/** Is a `modelRef` still usable against the current Providers state? */
function isModelRefValid(
  connections: readonly Connection[],
  ref: { connectionId: string; modelId: string } | undefined,
): boolean {
  if (!ref) return false;
  const conn = findConnection(connections, ref.connectionId);
  if (!conn || !isConnected(conn)) return false;
  if (!conn.starredModelIds.includes(ref.modelId)) return false;
  if (!capabilitiesFor(ref.modelId).includes("chat")) return false;
  return true;
}

/**
 * Compact session-level model picker in the chat composer. Reads the
 * active session's `modelRef` (via `ChatPanelContext`), the workspace
 * `ActiveModel` as the last-selected hint, and the per-Connection
 * starred sets. Selecting a model writes both the session's `modelRef`
 * and the workspace `ActiveModel` (the latter is the next-new-session
 * hint).
 *
 * Renders a recovery message when the session's stored `modelRef`
 * doesn't resolve to a currently-starred, connected, chat-capable
 * model.
 */
export function ComposerSessionModelPicker(): ReactElement {
  const workspace = useAppWorkspace();
  const commands = useAdapter(Commands);
  const panelCtx = useChatPanelContext();
  const sessionId = panelCtx?.sessionId;

  const config = useAdapterValue(Providers, (p) => p.config);
  const { connections, active: workspaceHint } = config;

  // Async load of session metadata. Validation against the current
  // `connections` re-runs on every render via `refValid`, so we don't
  // need to re-fetch the metadata on Providers updates — only when
  // the session id changes.
  const [sessionRef, setSessionRef] = useState<
    { connectionId: string; modelId: string } | null | undefined
  >(undefined);
  useEffect(() => {
    if (!sessionId) {
      setSessionRef(null);
      return;
    }
    const runtimeState = workspace.requireAdapter(AgentRuntimeAdapter).getState();
    if (runtimeState.status !== "ready") return;
    let cancelled = false;
    void runtimeState.runtime.getSessionMetadata(sessionId).then((meta) => {
      if (cancelled) return;
      setSessionRef(meta?.modelRef ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, workspace]);

  const choices = useMemo(() => buildChoices(connections), [connections]);
  const refValid = isModelRefValid(connections, sessionRef ?? undefined);

  // Trigger value: session modelRef if valid, else workspace hint
  // if valid, else placeholder.
  const hintRef =
    workspaceHint.providerId && workspaceHint.modelId
      ? { connectionId: workspaceHint.providerId, modelId: workspaceHint.modelId }
      : undefined;
  const triggerRef = refValid
    ? (sessionRef as { connectionId: string; modelId: string })
    : isModelRefValid(connections, hintRef)
      ? (hintRef as { connectionId: string; modelId: string })
      : null;
  const triggerValue = triggerRef ? `${triggerRef.connectionId}::${triggerRef.modelId}` : "";

  // Recovery banner: session has a stored ref that no longer resolves.
  const showRecovery = sessionRef != null && !refValid;

  // No connections at all → loud CTA to open Settings.
  if (connections.length === 0) {
    return (
      <button
        type="button"
        className="rounded-md border border-primary bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20"
        onClick={() => {
          void commands.call(ConfigureModelsCommand, {});
        }}
      >
        Configure models…
      </button>
    );
  }

  const handleSelect = (next: string): void => {
    if (next === CONFIGURE) {
      const typeHint = triggerRef
        ? findConnection(connections, triggerRef.connectionId)?.type
        : undefined;
      void commands.call(ConfigureModelsCommand, typeHint ? { typeHint } : {});
      return;
    }
    if (next === NO_MODELS) return;
    const [connectionId, modelId] = next.split("::");
    if (!connectionId || !modelId) return;

    // Workspace last-selected hint (drives AgentRuntimeAdapter
    // status + new-session inheritance).
    void commands.call(SelectActiveModelCommand, {
      providerId: connectionId,
      modelId,
    });

    // Per-session ref.
    if (sessionId) {
      const runtimeState = workspace.requireAdapter(AgentRuntimeAdapter).getState();
      if (runtimeState.status === "ready") {
        void runtimeState.runtime
          .setSessionModelRef(sessionId, { connectionId, modelId })
          .then(() => {
            setSessionRef({ connectionId, modelId });
          });
      }
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {showRecovery ? (
        <p className="px-2 text-xs text-amber-700 dark:text-amber-400">
          Previous model is no longer available — pick another.
        </p>
      ) : null}
      <Select value={triggerValue || NO_MODELS} onValueChange={handleSelect}>
        <SelectTrigger className="h-8 min-w-[10rem] border-0 bg-transparent px-2 text-xs hover:bg-accent">
          <SelectValue placeholder="Pick a model…" />
        </SelectTrigger>
        <SelectContent>
          {choices.length === 0 ? (
            <SelectItem value={NO_MODELS} disabled>
              <span className="text-xs text-muted-foreground">No chat-capable starred models</span>
            </SelectItem>
          ) : (
            choices.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                <span className="font-medium">{c.label}</span>
                <span className="ml-2 text-xs text-muted-foreground">{c.providerLabel}</span>
              </SelectItem>
            ))
          )}
          <SelectItem value={CONFIGURE}>
            <span className="text-xs text-muted-foreground">Configure models…</span>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
