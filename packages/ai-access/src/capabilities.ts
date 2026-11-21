// Capabilities (statewalker/statewalker-root#78, #80, amended by #157): each workspace's root key,
// held only by its Workspace DO, signs one capability per user: the user capability, which the
// user's User DO keeps in their user session. The User DO attenuates it for each agent session
// (agent, project, mode) with one block, offline; the agent session holds that capability, never
// the access token. The gate reads user, project and session from the capability itself (the user
// from the root-signed authority block, the rest from the first attenuation block), so it never
// asks the User DO, and authorizes every file action with the permissions the member's roles grant
// at that moment (statewalker/statewalker-root#123), each role decided on its own so a role's
// checks narrow only that role.
import {
  Biscuit,
  fromBase64,
  generateKeypair,
  type Keypair,
  type Term,
  toBase64,
  type VerifiedBiscuit,
} from "@statewalker/webrun-biscuit";
import { codedError } from "./errors.js";
import { type RoleGrant, roleAuthorizer } from "./permissions.js";

/** The file actions the gate authorizes: `files.read` and `files.list` for now. */
export type FileAction = "read" | "list";

/** A file action of an agent session, with the facts the Workspace DO knows when it happens. */
export interface FileRequest {
  action: FileAction;
  /** Normalised, absolute in the workspace. */
  path: string;
  /** The session's project, as its capability names it. */
  project: string;
  /** What the member's roles grant in the project now (none for a non-member). */
  grants: readonly RoleGrant[];
}

/** What the User DO narrows a user capability to for one agent session. */
export interface AgentSessionGrant {
  session: string;
  project: string;
  agent: string;
  mode: string;
}

/** What an agent session's capability says: its user (root-signed) and its grant. */
export interface AgentSessionFacts extends AgentSessionGrant {
  user: string;
}

// The facts of a file action the capability's blocks check. `resource` and `root` end in "/", so a
// project's prefix never matches a sibling ("/alpha/" is no prefix of "/alphabet/"); the role
// policy also requires the resource to be under the project's root.
const FILE_FACTS = `resource({path});
root({root});
check if resource($p), root($x), $p.starts_with($x);`;

// The agent session's block: its grant as facts, which the gate reads, and a check that binds
// every resource to the project's folder, whatever any later block or the gate says.
const AGENT_BLOCK = `agent_session({session});
project({project});
agent({agent});
mode({mode});
check if resource($p), $p.starts_with({root});`;

const GRANT_FACTS = ["agent_session", "project", "agent", "mode"] as const;

/** A first-level folder or a user's name: one path segment, never "." or "..". */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

const term = (t: unknown) => (t as { v: unknown }).v;

/**
 * The user capability narrowed to one agent session, by appending one block: no key is needed,
 * and nothing in a later block can widen it.
 */
export function attenuateForAgentSession(userCapability: string, grant: AgentSessionGrant): string {
  if (!NAME.test(grant.project)) throw codedError("EINVAL", "project must be a project's name");
  return Biscuit.fromBase64(userCapability)
    .attenuate(AGENT_BLOCK, {
      params: {
        session: grant.session,
        project: grant.project,
        agent: grant.agent,
        mode: grant.mode,
        root: `/${grant.project}/`,
      },
    })
    .toBase64();
}

/** Serialisable root keys, for the Workspace DO to keep in its own storage. */
export interface StoredRootKey {
  secret: string;
  public: string;
}

/** The authority of one workspace: its root key, minting and checking capabilities. */
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

  /** The capability of one user in this workspace, for their user session. */
  mintUser(user: string): string {
    if (!NAME.test(user)) throw codedError("EINVAL", "invalid user name");
    return Biscuit.build(this.#keys.secretKey, "user({user});", { params: { user } }).toBase64();
  }

  async #verify(capability: string): Promise<VerifiedBiscuit> {
    try {
      return await Biscuit.fromBase64(capability).verifyAsync(this.#keys.publicKey);
    } catch {
      throw codedError("EACCES", "invalid capability");
    }
  }

  #userOf(verified: VerifiedBiscuit): string {
    let user: unknown;
    try {
      user = verified.evaluate("allow if true;").query("u($u) <- user($u)")[0]?.terms[0];
    } catch {
      // falls through to the refusal
    }
    if (user === undefined) throw codedError("EACCES", "invalid capability");
    return String(term(user));
  }

  /** The user a capability signed by this workspace's root key names; else EACCES. */
  async userOf(capability: string): Promise<string> {
    return this.#userOf(await this.#verify(capability));
  }

  /**
   * What an agent session's capability says: the user from its root-signed authority block, and
   * the session, project, agent and mode from its first attenuation block, which the User DO
   * wrote. A capability without that block (a bare user capability) is refused: only agent
   * sessions reach the gate.
   */
  async agentSessionOf(capability: string): Promise<AgentSessionFacts> {
    const verified = await this.#verify(capability);
    const user = this.#userOf(verified);
    const block = verified.token.blocks[1];
    if (!block || block.externalKey !== undefined)
      throw codedError("EACCES", "not an agent session's capability");
    const values: Record<string, string> = {};
    for (const name of GRANT_FACTS) {
      const facts = block.facts.filter((f) => f.predicate.name === name);
      const t = facts[0]?.predicate.terms[0] as Term | undefined;
      if (facts.length !== 1 || facts[0]?.predicate.terms.length !== 1 || t?.t !== "str")
        throw codedError("EACCES", "not an agent session's capability");
      values[name] = t.v;
    }
    const project = String(values.project);
    if (!NAME.test(project)) throw codedError("EACCES", "not an agent session's capability");
    return {
      user,
      session: String(values.agent_session),
      project,
      agent: String(values.agent),
      mode: String(values.mode),
    };
  }

  /**
   * Authorizes one file action under a capability: allowed when one of the member's roles grants
   * `files.<action>` on the path relative to the project, within that role's checks, and every
   * block of the capability agrees; EACCES otherwise.
   */
  async authorize(capability: string, req: FileRequest): Promise<void> {
    let ok = false;
    try {
      const verified = await this.#verify(capability);
      const root = `/${req.project}/`;
      const resource = req.path === "/" ? "/" : `${req.path}/`;
      const inProject = resource.startsWith(root);
      const target = inProject ? `/${resource.slice(root.length)}`.replace(/(.)\/$/, "$1") : "";
      const extra = { code: FILE_FACTS, params: { path: resource, root } };
      ok =
        inProject &&
        req.grants.some((grant) => {
          const { code, params } = roleAuthorizer(
            grant,
            { area: "files", action: req.action, target },
            extra,
          );
          try {
            return verified.authorize(code, { params }).kind === "ok";
          } catch {
            return false;
          }
        });
    } catch {
      ok = false;
    }
    if (!ok) throw codedError("EACCES", `may not ${req.action} '${req.path}'`);
  }
}
