// Access tokens (statewalker/statewalker-root#78): Biscuit tokens signed by the deployment's token
// issuer, naming only the user, the workspace, the issuer and the expiry. Nothing about roles or
// rights: those are read live where each action happens.
import { Biscuit, generateKeypair, type Keypair } from "@statewalker/webrun-biscuit";
import { codedError } from "./errors.js";

export interface AccessClaims {
  user: string;
  workspace: string;
  issuer: string;
  /** Milliseconds since the epoch. */
  expires: number;
}

const DEFAULT_TTL_MS = 3_600_000;

/** The deployment's token issuer: one per deployment, holding its signing key. */
export class TokenIssuer {
  readonly #keys: Keypair;
  readonly id: string;
  readonly ttlMs: number;

  constructor(keys: Keypair, options: { id: string; ttlMs?: number }) {
    this.#keys = keys;
    this.id = options.id;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  static generateKeys(): Keypair {
    return generateKeypair();
  }

  get publicKey(): Uint8Array {
    return this.#keys.publicKey;
  }

  /** Signs an access token for a user already identified (an identity provider's job). */
  issue(user: string, workspace: string, ttlMs = this.ttlMs): { token: string; expires: number } {
    if (!user || !workspace)
      throw codedError("EINVAL", "an access token names a user and a workspace");
    const expires = Date.now() + ttlMs;
    const token = Biscuit.build(
      this.#keys.secretKey,
      "user({user});\nworkspace({workspace});\nissuer({issuer});\nexpires({expires});",
      { params: { user, workspace, issuer: this.id, expires } },
    ).toBase64();
    return { token, expires };
  }
}

const term = (t: unknown) => (t as { v: unknown }).v;

/**
 * The claims of an access token signed by the issuer whose public key is given, for this workspace
 * and not expired. Anything else is EAUTH.
 */
export async function verifyAccessToken(
  token: string,
  issuerPublicKey: Uint8Array,
  expected: { workspace: string; now?: number },
): Promise<AccessClaims> {
  let facts: unknown[] | undefined;
  try {
    const verified = await Biscuit.fromBase64(token).verifyAsync(issuerPublicKey);
    facts = verified
      .evaluate("allow if true;")
      .query("claims($u, $w, $i, $e) <- user($u), workspace($w), issuer($i), expires($e)")[0]
      ?.terms.map(term);
  } catch {
    throw codedError("EAUTH", "invalid access token");
  }
  if (!facts) throw codedError("EAUTH", "invalid access token");
  const [user, workspace, issuer, expires] = facts;
  if (workspace !== expected.workspace)
    throw codedError("EAUTH", "the access token is for another workspace");
  if (Number(expires) <= (expected.now ?? Date.now()))
    throw codedError("EAUTH", "access token expired");
  return {
    user: String(user),
    workspace: String(workspace),
    issuer: String(issuer),
    expires: Number(expires),
  };
}
