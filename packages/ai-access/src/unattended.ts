// Unattended agent sessions (statewalker/statewalker-root#127, spec #111 "Modes and auto"): started
// with no one present, so nobody can answer an approval. Every "ask" a mode or a rule gives becomes
// a deny that says why, and the agent carries on with the refusal as its tool's result.

import type { Verdict } from "./modes.js";

/** The decision to act on: an ask in an unattended session is a deny with a reason. */
export function settleAsk<T extends { verdict: Verdict; reason: string }>(
  decision: T,
  session: { unattended: boolean },
): T {
  if (decision.verdict !== "ask" || !session.unattended) return decision;
  return {
    ...decision,
    verdict: "deny",
    reason: `${decision.reason}; the session is unattended, so nobody can approve it`,
  };
}
