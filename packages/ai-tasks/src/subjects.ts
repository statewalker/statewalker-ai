// Subjects (statewalker/statewalker-root#160): `.`-separated tokens, as in NATS. A filter may hold
// `*` (exactly one token) and, as its last token, `>` (one or more tokens). Inboxes (`_inbox.<id>`)
// are reached only by their own subject: no wildcard filter matches them.

/** The prefix of reply inboxes: `_inbox.<id>`. */
export const INBOX_PREFIX = "_inbox.";

const TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_:@-]{0,63}$/;
const MAX_TOKENS = 16;
const MAX_LENGTH = 256;

const tokensOf = (text: unknown): string[] | undefined => {
  if (typeof text !== "string" || !text || text.length > MAX_LENGTH) return undefined;
  const tokens = text.split(".");
  return tokens.length > MAX_TOKENS ? undefined : tokens;
};

/** A subject a task is published under: tokens of letters, digits, `_`, `-`, `:` and `@`. */
export function isSubject(text: unknown): text is string {
  const tokens = tokensOf(text);
  return !!tokens && tokens.every((t) => TOKEN.test(t));
}

/** A subscription's subject filter: a subject whose tokens may be `*`, and whose last may be `>`. */
export function isPattern(text: unknown): text is string {
  const tokens = tokensOf(text);
  return (
    !!tokens &&
    tokens.every((t, i) => TOKEN.test(t) || t === "*" || (t === ">" && i === tokens.length - 1))
  );
}

export const isInbox = (subject: string): boolean => subject.startsWith(INBOX_PREFIX);

/** Whether a filter matches a subject; an inbox matches only its own subject. */
export function subjectMatches(pattern: string, subject: string): boolean {
  if (isInbox(subject)) return pattern === subject;
  const pat = pattern.split(".");
  const toks = subject.split(".");
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i];
    if (p === ">" && i === pat.length - 1) return toks.length > i;
    if (i >= toks.length) return false;
    if (p !== "*" && p !== toks[i]) return false;
  }
  return toks.length === pat.length;
}
