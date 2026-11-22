// The scans on every memory write and again at load (statewalker/statewalker-root#157): text that
// would steer a later session (prompt injection), send data out (exfiltration), or carry a secret
// (a key's shape, or the value of any secret the harness stores) never goes into memory; at load,
// an entry that fails is flagged to the user, never shown to the agent.

const INJECTION: [RegExp, string][] = [
  [
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|messages?)\b/i,
    "an instruction to ignore earlier instructions",
  ],
  [
    /\byou are now\b|\bact as (?:the )?(?:system|developer|admin)\b/i,
    "an attempt to reassign the agent's role",
  ],
  [/\b(system|developer) prompt\b/i, "a reference to the system prompt"],
  [
    /<\|?(?:im_start|im_end|system|endoftext)\|?>|\[\/?(?:INST|SYS)\]/i,
    "a chat-template control token",
  ],
  [/\bdo not (?:tell|inform|show) the user\b/i, "an instruction to hide something from the user"],
];

const EXFILTRATION: [RegExp, string][] = [
  [
    /\b(?:curl|wget|fetch|nc|ncat|scp|rsync)\b[^\n]{0,200}(?:https?:\/\/|\$\(|`)/i,
    "a command sending data out",
  ],
  [/!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*\?[^)\s]*=/i, "an image link carrying data in its URL"],
  [
    /\b(?:send|post|upload|forward|exfiltrate)\b[^.\n]{0,60}\b(?:to|at)\b\s*https?:\/\//i,
    "an instruction to send data to a URL",
  ],
  [/(?:\.ssh\/|id_rsa|\.aws\/credentials|\/etc\/passwd|\.env\b)/i, "a credentials file path"],
];

const SECRET_SHAPES: [RegExp, string][] = [
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bswk_[A-Za-z0-9_-]{16,}/, "a harness API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a signed token"],
];

/** Zero-width and bidirectional control characters: text the user cannot see. */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

/** Stored secret values shorter than this are not matched (they would match ordinary words). */
const MIN_SECRET = 6;

/**
 * Why `text` may not be memory, or undefined when it may. `secretValues` are the values of the
 * secrets the harness stores for the caller's scope (user, project, workspace, deployment).
 */
export function scanText(text: string, secretValues: readonly string[] = []): string | undefined {
  if (INVISIBLE.test(text)) return "refused by the memory scan: invisible characters";
  for (const [re, what] of INJECTION)
    if (re.test(text)) return `refused by the memory scan: prompt injection (${what})`;
  for (const [re, what] of EXFILTRATION)
    if (re.test(text)) return `refused by the memory scan: exfiltration (${what})`;
  for (const [re, what] of SECRET_SHAPES)
    if (re.test(text)) return `refused by the memory scan: a secret (${what})`;
  for (const value of secretValues)
    if (value.length >= MIN_SECRET && text.includes(value))
      return "refused by the memory scan: a secret (a stored secret's value)";
  return undefined;
}
