// Service accounts (statewalker/statewalker-root#78, #127): non-human users, such as CI jobs and
// scheduled agents, holding access tokens and project roles like any user. Each belongs to one
// workspace, and its user name is in a form the token issuer never signs for a human identity, so
// no identity provider can sign in as one. It proves who it is with an API key, which the issuer
// keeps only as a hash.
import { toBase64 } from "@statewalker/webrun-biscuit";
import { codedError } from "./errors.js";

/** A service account's own name, as a workspace admin gives it. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A workspace's name, as the deployment's configuration gives it. */
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** The reserved form: `<name>@<workspace>.svc`. */
const SERVICE_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}@[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.svc$/;

/** The user name of a workspace's service account. */
export function serviceAccountUser(workspace: string, name: string): string {
  if (!NAME.test(name))
    throw codedError("EINVAL", "a service account's name is letters, digits, '-' and '_'");
  if (!WORKSPACE.test(workspace))
    throw codedError("EINVAL", `'${workspace}' cannot hold service accounts`);
  return `${name}@${workspace}.svc`;
}

/** Whether a user name is in the service accounts' reserved form. */
export const isServiceAccount = (user: string): boolean => SERVICE_ACCOUNT.test(user);

/** A new API key: 32 random bytes, shown to its creator once. */
export function newApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `swk_${toBase64(bytes).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c] ?? "")}`;
}

/** The hash an API key is kept and looked up by (SHA-256, hex). */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
