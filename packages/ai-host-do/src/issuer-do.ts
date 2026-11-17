// The deployment's token issuer (statewalker/statewalker-root#78): one DO holding the signing key.

import { DurableObject } from "cloudflare:workers";
import { fromBase64, TokenIssuer, toBase64 } from "@statewalker/ai-access";
import type { Env } from "./env.js";

export class Issuer extends DurableObject<Env> {
  #issuer?: TokenIssuer;

  async #get(): Promise<TokenIssuer> {
    if (this.#issuer) return this.#issuer;
    let keys = await this.ctx.storage.get<{ secret: string; public: string }>("keys");
    if (!keys) {
      const kp = TokenIssuer.generateKeys();
      keys = { secret: toBase64(kp.secretKey), public: toBase64(kp.publicKey) };
      await this.ctx.storage.put("keys", keys);
    }
    this.#issuer = new TokenIssuer(
      { secretKey: fromBase64(keys.secret), publicKey: fromBase64(keys.public) },
      { id: "issuer", ttlMs: Number(this.env.TOKEN_TTL_MS ?? 3_600_000) },
    );
    return this.#issuer;
  }

  async publicKey(): Promise<string> {
    return toBase64((await this.#get()).publicKey);
  }

  /** Signs an access token for a user an identity provider has already identified. */
  async issue(user: string, workspace: string, ttlMs?: number) {
    return (await this.#get()).issue(user, workspace, ttlMs);
  }
}
