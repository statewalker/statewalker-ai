// The memory tool (statewalker/statewalker-root#157): the agent's only way to its memory. Each call
// names a kind and holds an atomic batch; project and agent memory are the Workspace DO's, user
// memory and preferences the user's User DO's (an agent session → user call, which proves the
// session by its capability). A batch that waits on the user's approval (every change of
// preferences, and an ask of a rule) ends the turn waiting on it; the user's answer runs exactly
// that batch again.
import type { ApprovalRequest } from "@statewalker/ai-access";
import { approvalOf, type StoredCall } from "@statewalker/ai-environment";
import type { HostTool } from "@statewalker/ai-flue";
import {
  type BatchResult,
  batchText,
  MEMORY_TOOL,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_SCHEMA,
  type MemoryAction,
  type MemoryCall,
  type MemorySnapshot,
  toolCall,
} from "@statewalker/ai-memory";
import type { AgentSessionConfig } from "@statewalker/ai-sessions";
import { type Env, userOf } from "./env.js";

export { MEMORY_TOOL };

/** Where a session's memory calls go: each kind to the DO that holds it. */
export interface MemoryHost {
  call(kind: string, call: MemoryCall): Promise<unknown>;
  /** Every kind whole, for priming: preferences, user, project, agent. */
  prime(): Promise<MemorySnapshot>;
}

export function memoryHost(env: Env, config: AgentSessionConfig): MemoryHost {
  const workspace = () => env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
  const user = () => userOf(env, config.user);
  const call = (kind: string, c: MemoryCall): Promise<unknown> =>
    kind === "project" || kind === "agent"
      ? workspace().memory(config.capability, c)
      : user().sessionMemory(config.id, config.capability, c);
  return {
    call,
    async prime() {
      const op = { op: "prime" } as unknown as MemoryCall;
      // A DO that cannot answer now leaves its kinds out; the turn still runs.
      const part = async (get: () => Promise<unknown>): Promise<MemorySnapshot> => {
        try {
          return (await get()) as MemorySnapshot;
        } catch (e) {
          console.warn(`memory of ${config.id}: ${String((e as Error)?.message ?? e)}`);
          return { kinds: [], flagged: [], skipped: [] };
        }
      };
      const mine = await part(() => user().sessionMemory(config.id, config.capability, op));
      const shared = await part(() => workspace().memory(config.capability, op));
      return {
        kinds: [...mine.kinds, ...shared.kinds],
        flagged: [...mine.flagged, ...shared.flagged],
        skipped: [...mine.skipped, ...shared.skipped],
      };
    },
  };
}

const batchOf = (kind: string, actions: MemoryAction[]): MemoryCall => ({
  op: "batch",
  kind,
  actions,
});

/** The memory tool of one session. */
export function memoryTool(
  host: MemoryHost,
  onApproval: (request: ApprovalRequest, call: StoredCall) => void,
): HostTool {
  let waitingOn: ApprovalRequest | undefined;
  return {
    name: MEMORY_TOOL,
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: MEMORY_TOOL_SCHEMA as unknown as Record<string, unknown>,
    async execute(args) {
      try {
        const { kind, actions } = toolCall(args ?? {});
        // A turn waiting on an approval runs no further change: it ends at the pending call.
        if (waitingOn) throw new Error(`waiting on the user's approval ${waitingOn.id}`);
        try {
          const result = (await host.call(kind, batchOf(kind, actions))) as BatchResult;
          return { output: batchText(result), isError: false };
        } catch (e) {
          const request = approvalOf(e);
          if (!request) throw e;
          waitingOn = request;
          onApproval(request, {
            method: "memory",
            path: kind,
            content: new TextEncoder().encode(JSON.stringify(actions)),
          });
          throw new Error(`waiting on the user's approval ${request.id}: ${request.reason}`);
        }
      } catch (e) {
        return { output: String((e as Error)?.message ?? e), isError: true };
      }
    },
  };
}

/** Runs an approved memory batch again: its answer, or `{$approval}` if it still waits. */
export async function runStoredMemoryCall(host: MemoryHost, call: StoredCall) {
  const actions = JSON.parse(
    new TextDecoder().decode(call.content ?? new Uint8Array()),
  ) as MemoryAction[];
  try {
    const result = (await host.call(call.path, batchOf(call.path, actions))) as BatchResult;
    return { output: batchText(result), isError: false };
  } catch (e) {
    const request = approvalOf(e);
    if (request) return { $approval: request };
    throw e;
  }
}
