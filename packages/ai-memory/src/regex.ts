// The regular expressions a search accepts (statewalker/statewalker-root#157, #174): memory's
// `search` action and `session_search` scan texts with a pattern the agent writes, inside the DO
// that holds them, where nothing stops a runaway match. A group that is repeated (`*`, `+`, `{n,}`,
// `{n,m}`) while it holds a repetition or an alternation, at any depth (`(a+)+`, `(a|a)*`,
// `((a|b))+`), can backtrack exponentially: such a pattern is refused (EINVAL). Character classes
// and escapes are read as such; `?` and `{0,1}`-style optional groups repeat nothing.
import { codedError } from "@statewalker/ai-access";

/** Why a pattern may backtrack for ever, if it may. */
export function riskyPattern(pattern: string): string | undefined {
  // Per open group: whether it (or a group inside it) holds a repetition or an alternation.
  const stack: boolean[] = [];
  let risky = false; // the last closed group's
  let afterGroup = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const repeat = (): boolean => {
      if (c === "*" || c === "+") return true;
      if (c === "{") {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
        if (!m) return false;
        const max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
        return max > 1;
      }
      return false;
    };
    if (c === "\\") {
      i++;
      afterGroup = false;
      continue;
    }
    if (c === "[") {
      for (i++; i < pattern.length && pattern[i] !== "]"; i++) if (pattern[i] === "\\") i++;
      afterGroup = false;
      continue;
    }
    if (afterGroup && repeat() && risky)
      return "a repeated group holds a repetition or an alternation";
    if (c === "(") {
      stack.push(false);
      afterGroup = false;
      continue;
    }
    if (c === ")") {
      risky = stack.pop() ?? false;
      if (risky && stack.length) stack[stack.length - 1] = true;
      afterGroup = true;
      continue;
    }
    if ((c === "|" || repeat()) && stack.length) stack[stack.length - 1] = true;
    afterGroup = false;
  }
  return undefined;
}

/** A search's regular expression, case-insensitive; EINVAL for a malformed or risky pattern. */
export function searchRegExp(pattern: string): RegExp {
  const risk = riskyPattern(pattern);
  if (risk)
    throw codedError(
      "EINVAL",
      `not searched: ${risk}, which can backtrack for ever (use a character class, such as [\\w\\d]+)`,
    );
  try {
    return new RegExp(pattern, "i");
  } catch (e) {
    throw codedError("EINVAL", `not a regular expression: ${(e as Error).message}`);
  }
}
