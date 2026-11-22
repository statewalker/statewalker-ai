// The harness tool `session_search` (statewalker/statewalker-root#157, #174): the agent searches
// its user's own earlier agent sessions in its project, sub-agents' included. The User DO names the
// sessions in scope (an agent session → user call proven by the session's capability, as memory
// is); each session's DO scans its own topics and items. No model summarizes the results: they
// reach the model fenced as data.
import type { HostTool } from "@statewalker/ai-flue";
import {
  type AgentSessionConfig,
  type IndexedSession,
  openedText,
  type ScannableSession,
  SESSION_SEARCH_DESCRIPTION,
  SESSION_SEARCH_SCHEMA,
  SESSION_SEARCH_TOOL,
  type SessionSearch,
  scanSessionSearch,
  searchText,
  sessionSearchCall,
} from "@statewalker/ai-sessions";
import { agentOf, type Env, userOf } from "./env.js";

export { SESSION_SEARCH_TOOL };

/** The search of one agent session: its user's sessions in its project, scanned in their DOs. */
export function sessionSearchOf(env: Env, config: AgentSessionConfig): SessionSearch {
  return scanSessionSearch({
    sessions: async () =>
      (
        (await userOf(env, config.user).searchScope(config.id, config.capability)) as {
          sessions: IndexedSession[];
        }
      ).sessions,
    session: (id) => agentOf(env, id) as unknown as ScannableSession,
  });
}

/** The tool over a session search. */
export function sessionSearchTool(search: SessionSearch): HostTool {
  return {
    name: SESSION_SEARCH_TOOL,
    description: SESSION_SEARCH_DESCRIPTION,
    parameters: SESSION_SEARCH_SCHEMA as unknown as Record<string, unknown>,
    async execute(args) {
      try {
        const call = sessionSearchCall(args ?? {});
        return call.op === "open"
          ? { output: openedText(await search.open(call.request)), isError: false }
          : { output: searchText(await search.search(call.query)), isError: false };
      } catch (e) {
        return { output: String((e as Error)?.message ?? e), isError: true };
      }
    },
  };
}
