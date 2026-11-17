// Capabilities (statewalker/statewalker-root#78, #80): each workspace's root key, held only by its
// Workspace DO, signs one capability per agent session. The session holds its capability, never
// the user's access token.
import {
  Biscuit,
  fromBase64,
  generateKeypair,
  type Keypair,
  toBase64,
} from "@statewalker/webrun-biscuit";

/** Serialisable root keys, for the Workspace DO to keep in its own storage. */
export interface StoredRootKey {
  secret: string;
  public: string;
}

/** The authority of one workspace: its root key, minting and checking agent capabilities. */
export class WorkspaceAuthority {
  readonly #keys: Keypair;

  private constructor(keys: Keypair) {
    this.#keys = keys;
  }

  /** A new root key, as the Workspace DO stores it. */
  static generate(): StoredRootKey {
    const kp = generateKeypair();
    return { secret: toBase64(kp.secretKey), public: toBase64(kp.publicKey) };
  }

  static fromStored(stored: StoredRootKey): WorkspaceAuthority {
    return new WorkspaceAuthority({
      secretKey: fromBase64(stored.secret),
      publicKey: fromBase64(stored.public),
    });
  }

  /** The capability of one agent session. */
  mint(agentSession: string): string {
    return Biscuit.build(this.#keys.secretKey, "agent_session({id});", {
      params: { id: agentSession },
    }).toBase64();
  }
}
