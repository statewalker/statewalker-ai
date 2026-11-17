// Capabilities (statewalker/statewalker-root#78, #80): each workspace's root key, held only by its
// Workspace DO, signs one capability per agent session. The session holds its capability, never
// the user's access token, and every file action it takes is authorized against it, with the
// member's role read at that moment.
import {
  Biscuit,
  fromBase64,
  generateKeypair,
  type Keypair,
  toBase64,
} from "@statewalker/webrun-biscuit";
import { codedError } from "./errors.js";

export type FileAction = "read";

/** A file action of an agent session, with the facts the Workspace DO knows when it happens. */
export interface FileRequest {
  action: FileAction;
  /** Normalised, absolute in the workspace. */
  path: string;
  /** The session's project. */
  project: string;
  /** The member's role in the project now, if any. */
  role: string | undefined;
}

// The roles' file permissions, as Datalog over the capability. `resource` and `root` end in "/",
// so a project's prefix never matches a sibling ("/alpha/" is no prefix of "/alphabet/").
const POLICY = `
check if agent_session({session});
allow if operation("read"), role($r), {"reader", "editor", "owner"}.contains($r), resource($p), root($x), $p.starts_with($x);
deny if true;
`;

const term = (t: unknown) => (t as { v: unknown }).v;

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

  /** The agent session a capability signed by this workspace's root key names; else EACCES. */
  async sessionOf(capability: string): Promise<string> {
    try {
      const verified = await Biscuit.fromBase64(capability).verifyAsync(this.#keys.publicKey);
      const id = verified.evaluate("allow if true;").query("s($id) <- agent_session($id)")[0]
        ?.terms[0];
      if (id !== undefined) return String(term(id));
    } catch {
      // falls through to the refusal
    }
    throw codedError("EACCES", "invalid capability");
  }

  /** Authorizes one file action of the session the capability names; EACCES when refused. */
  async authorize(capability: string, session: string, req: FileRequest): Promise<void> {
    let ok = false;
    try {
      const verified = await Biscuit.fromBase64(capability).verifyAsync(this.#keys.publicKey);
      const facts = `operation({op});\nresource({path});\nroot({root});\n${req.role ? "role({role});\n" : ""}`;
      ok =
        verified.authorize(facts + POLICY, {
          params: {
            op: req.action,
            path: req.path === "/" ? "/" : `${req.path}/`,
            root: `/${req.project}/`,
            session,
            ...(req.role ? { role: req.role } : {}),
          },
        }).kind === "ok";
    } catch {
      ok = false;
    }
    if (!ok) throw codedError("EACCES", `may not ${req.action} '${req.path}'`);
  }
}
