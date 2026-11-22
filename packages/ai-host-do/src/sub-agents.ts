// The harness tool `agent.start` (statewalker/statewalker-root#126, decided in #87 and #89): an
// agent session starts a child session and gets its answer. Flue's own sub-agents can't be given a
// narrower sandbox, so delegation is a harness tool: the child is a session of its own, with a
// capability the workspace narrows from the parent's (so it can do nothing its parent can't and
// stops when any ancestor is revoked), tools within the parent's, and a mode that may only be
// stricter. The model calls it `agent_start` (tool names hold no dots).
import { type ApprovalRequest, codedError } from "@statewalker/ai-access";
import type { StoredCall } from "@statewalker/ai-environment";
import type { HostTool } from "@statewalker/ai-flue";
import type {
  AgentSessionConfig,
  SubAgentOutcome,
  SubAgentRequest,
  TurnView,
} from "@statewalker/ai-sessions";

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

/**
 * The approvals a child's turn waits on that it asked itself, as their requests: the ones the
 * parent's turn then waits on too (statewalker/statewalker-ai#88).
 */
export function askedBy(turn: TurnView): ApprovalRequest[] {
  if (turn.status !== "waiting") return [];
  const ids = turn.stop_reason?.approval_ids ?? [];
  const out: ApprovalRequest[] = [];
  for (const item of turn.items)
    if (
      (item.kind === "approval" || item.kind === "question") &&
      item.approval &&
      item.request &&
      ids.includes(item.approval) &&
      !out.some((r) => r.id === item.approval)
    )
      out.push(item.request as ApprovalRequest);
  return out;
}

/**
 * What a child's turn that continued it with an answer hands back to the parent waiting on that
 * answer: its outcome, or the approvals it waits on now.
 */
export function outcomeOf(session: string, turn: TurnView): SubAgentOutcome {
  const waiting = askedBy(turn);
  const answer = answerOf(session, turn);
  // What the answered action did (run, or denied), so the parent learns it whatever the child says.
  const done = turn.items
    .filter((i) => i.kind === "tool_result" && i.approval && i.output)
    .map((i) => String(i.output));
  const [head, ...rest] = answer.output.split("\n");
  return {
    ...answer,
    output: [head, ...done, ...rest].join("\n"),
    ...(turn.status === "waiting" ? { waiting } : {}),
  };
}

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
 * offered, so the child's are always among them. A child whose turn waits on approvals it asked
 * makes the caller's turn wait on them too (`onApproval`, as a stored `agent` action): the user's
 * answer continues the child, then the caller with the child's outcome
 * (statewalker/statewalker-ai#88).
 */
export function agentStartTool(
  offered: readonly string[],
  host: SubAgentHost,
  onApproval?: (request: ApprovalRequest, call: StoredCall) => void,
): HostTool {
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
        const turn = await host.run(config, message, signal);
        const asked = onApproval ? askedBy(turn) : [];
        for (const request of asked)
          onApproval?.(request, { method: "agent", path: session.id, target: request.id });
        const answer = answerOf(session.id, turn);
        // Like any call waiting on an approval: an error result naming it (the answer is its result).
        return asked.length ? { ...answer, isError: true } : answer;
      } catch (e) {
        return { output: String((e as Error)?.message ?? e), isError: true };
      }
    },
  };
}
