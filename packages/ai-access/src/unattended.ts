// Unattended agent sessions (statewalker/statewalker-root#127, spec #111 "Modes and auto"): started
// with no one present, so nobody can answer an approval. Every "ask" a mode or a rule gives becomes
// a deny that says why, and the agent carries on with the refusal as its tool's result.

/** A verdict on one action, as modes and permission rules give it. */
export interface Verdict {
  verdict: "allow" | "ask" | "deny";
  reason: string;
}

/** The verdict to act on: an ask in an unattended session is a deny with a reason. */
export function settleAsk<T extends Verdict>(decision: T, session: { unattended: boolean }): T {
  if (decision.verdict !== "ask" || !session.unattended) return decision;
  return {
    ...decision,
    verdict: "deny",
    reason: `${decision.reason}; the session is unattended, so nobody can approve it`,
  };
}
