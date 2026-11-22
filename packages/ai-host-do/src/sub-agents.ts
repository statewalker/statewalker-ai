// The harness tool `agent.start` (statewalker/statewalker-root#126, decided in #87 and #89): an
// agent session starts a child session and gets its answer. Flue's own sub-agents can't be given a
// narrower sandbox, so delegation is a harness tool: the child is a session of its own, with a
// capability the workspace narrows from the parent's (so it can do nothing its parent can't and
// stops when any ancestor is revoked), tools within the parent's, and a mode that may only be
// stricter. The model calls it `agent_start` (tool names hold no dots).
import { codedError } from "@statewalker/ai-access";
import type { HostTool } from "@statewalker/ai-flue";
import type { AgentSessionConfig, SubAgentRequest, TurnView } from "@statewalker/ai-sessions";

export const AGENT_START = "agent_start";

/** What the tool needs of the host. */
export interface SubAgentHost {
  /** The User DO starts the child (the index entry and its capability). */
  startSubAgent(
    req: SubAgentRequest,
  ): Promise<{ session: { id: string }; config: AgentSessionConfig }>;
  /** Starts the child's DO, sends it the message, and waits for that turn to end. */
  run(config: AgentSessionConfig, message: string, signal?: AbortSignal): Promise<TurnView>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;

/** What the child's turn hands back to the parent's model. */
function answerOf(session: string, turn: TurnView): { output: string; isError: boolean } {
  const said = turn.items
    .filter((i) => i.kind === "message" && i.role === "assistant" && i.text)
    .map((i) => String(i.text))
    .join("\n");
  const head = `sub-agent session ${session}, turn ${turn.status}`;
  if (turn.status === "waiting")
    return {
      output: `${head}: waiting on the user's approval of ${(turn.stop_reason?.approval_ids ?? []).join(", ")}${said ? `\n${said}` : ""}`,
      isError: false,
    };
  if (turn.status !== "completed")
    return { output: `${head}${turn.error ? `: ${turn.error}` : ""}`, isError: true };
  return { output: `${head}\n${said}`, isError: false };
}

/**
 * The `agent.start` tool of one session: `offered` are the names of the tools that session is
 * offered, so the child's are always among them.
 */
export function agentStartTool(offered: readonly string[], host: SubAgentHost): HostTool {
  return {
    name: AGENT_START,
    description:
      "Starts a sub-agent: a child session running another agent on a task, with at most your " +
      "own tools and mode. Answers with what the sub-agent said.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent to run." },
        message: { type: "string", description: "The task, as the sub-agent's first message." },
        mode: { type: "string", description: "A stricter mode for the sub-agent." },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "The tools the sub-agent may use, among your own (default: all of yours).",
        },
      },
      required: ["agent", "message"],
      additionalProperties: false,
    },
    async execute(args, signal) {
      try {
        const { agent, message, mode, tools } = args as Record<string, unknown>;
        if (typeof agent !== "string" || !NAME.test(agent))
          throw codedError("EINVAL", "agent must be an agent's name");
        if (typeof message !== "string" || !message)
          throw codedError("EINVAL", "message must be a non-empty string");
        if (mode !== undefined && typeof mode !== "string")
          throw codedError("EINVAL", "mode must be a mode's name");
        if (
          tools !== undefined &&
          !(Array.isArray(tools) && tools.every((x) => typeof x === "string"))
        )
          throw codedError("EINVAL", "tools must be a list of tool names");
        // Never more than the caller's own tools.
        const allowed = tools ? offered.filter((name) => tools.includes(name)) : [...offered];
        const { session, config } = await host.startSubAgent({
          agent,
          ...(mode ? { mode } : {}),
          tools: allowed,
        });
        return answerOf(session.id, await host.run(config, message, signal));
      } catch (e) {
        return { output: String((e as Error)?.message ?? e), isError: true };
      }
    },
  };
}
