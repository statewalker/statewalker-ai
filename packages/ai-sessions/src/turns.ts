// Turn ids name their agent session, so a turn is reached by its id alone.
import { codedError } from "@statewalker/ai-access";

/** The id of the agent session a turn belongs to: a turn id names its session. */
export function sessionOfTurn(turnId: string): string {
  const at = String(turnId).lastIndexOf(".tu-");
  if (at <= 0) throw codedError("ENOENT", "no such turn");
  return turnId.slice(0, at);
}
