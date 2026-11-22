// Capabilities (statewalker/statewalker-root#78, #80, amended by #157): each workspace's root key,
// held only by its Workspace DO, signs one capability per user: the user capability, which the
// user's User DO keeps in their user session. The User DO attenuates it for each agent session
// (agent, project) with one block, offline; the agent session holds that capability, never
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
  thirdPartyBlock,
  toBase64,
  type VerifiedBiscuit,
} from "@statewalker/webrun-biscuit";
import { codedError } from "./errors.js";
import { type RoleGrant, roleAuthorizer } from "./permissions.js";

/** The file actions the gate authorizes: `files.read`, `files.list`, `files.write`, `files.delete`. */
export type FileAction = "read" | "list" | "write" | "delete";

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

/**
 * What the User DO narrows a user capability to for one agent session. The mode is not in it: the
 * user switches modes at any time, and the gate reads the current one at every action
 * (statewalker/statewalker-root#124).
 */
export interface AgentSessionGrant {
  session: string;
  project: string;
  agent: string;
  /**
   * Started with no one present (a service account's schedule, a trigger): every "ask" becomes a
   * deny with a reason (statewalker/statewalker-root#127). Fixed in the capability, so no later
   * block can undo it.
   */
  unattended?: boolean;
}

/**
 * What the Workspace DO narrows a parent agent session's capability to for a sub-agent
 * (statewalker/statewalker-root#126): the child's session and agent, and a mode that may only make
 * the gate stricter than the user session's.
 */
export interface SubAgentGrant {
  session: string;
  agent: string;
  /** Modes the child's actions are also decided by: the strictest verdict wins. */
  modes?: string[];
}

/** A database action: `db.read`, `db.write` (DML and DDL) or `db.admin` (create and drop). */
export type DatabaseAction = "read" | "write" | "admin";

/** A database action of a holder, with the facts the Workspace DO knows when it happens. */
export interface DatabaseRequest {
  action: DatabaseAction;
  /** The database's name in its project. */
  database: string;
  project: string;
  /** What the member's roles grant in the project now (none for a non-member). */
  grants: readonly RoleGrant[];
}

/** The plugin tool a capability was narrowed for (statewalker/statewalker-root#81, #136). */
export interface ToolGrant {
  plugin: string;
  tool: string;
}

/** What an agent session's capability says: its user (root-signed) and its grant. */
export interface AgentSessionFacts extends AgentSessionGrant {
  user: string;
  unattended: boolean;
  /** A sub-agent's parent session. */
  parent?: string;
  /** A sub-agent's ancestors, the root session first. */
  lineage?: string[];
  /** The modes the sub-agent blocks add, each one only stricter (outermost first). */
  modes?: string[];
  /** The plugin tool the capability was narrowed for, by a block the workspace signed. */
  tool?: ToolGrant;
}

/** How a Workspace DO's authority is told about its revocation list. */
export interface AuthorityOptions {
  /**
   * Whether any of a capability's blocks is on the workspace's revocation list (each block's
   * revocation id); a capability with one is refused at its next use. Checked on every
   * verification, so a revocation stops everything narrowed from the revoked block.
   */
  isRevoked?(revocationIds: readonly string[]): boolean;
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
check if resource($p), $p.starts_with({root});`;

// Added to the agent session's block when it is unattended: its presence alone is the flag.
const UNATTENDED_FACT = "\nunattended(true);";

const GRANT_FACTS = ["agent_session", "project", "agent"] as const;

// A sub-agent's block, signed by the workspace's key as a third-party block: the gate trusts its
// facts because no holder can sign it. It adds no check: the parent's blocks still bind the child.
const SUB_AGENT_BLOCK = `agent_session({session});
parent_session({parent});
agent({agent});`;
const SUB_AGENT_FACTS = ["agent_session", "parent_session", "agent"] as const;

// A plugin tool's block, signed by the workspace's key as a third-party block: the tool's
// databases (`<plugin>:<name>`) are reached only with it. It adds no check: the session's blocks
// still bind the tool to the project, and revoking the session stops it.
const TOOL_BLOCK = `tool_plugin({plugin});
tool_name({tool});`;
const TOOL_FACTS = ["tool_plugin", "tool_name"] as const;
/** A plugin's name and a tool's (an operationId), as definitions name them. */
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** A database action's facts: every resource is the project's folder itself. */
const DATABASE_FACTS = `resource({root});
root({root});`;
const MODE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

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
    .attenuate(AGENT_BLOCK + (grant.unattended ? UNATTENDED_FACT : ""), {
      params: {
        session: grant.session,
        project: grant.project,
        agent: grant.agent,
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
  readonly #externalKey: string;
  readonly #isRevoked: (ids: readonly string[]) => boolean;

  private constructor(keys: Keypair, options: AuthorityOptions) {
    this.#keys = keys;
    this.#externalKey = `ed25519/${hex(keys.publicKey)}`;
    this.#isRevoked = options.isRevoked ?? (() => false);
  }

  /** A new root key, as the Workspace DO stores it. */
  static generate(): StoredRootKey {
    const kp = generateKeypair();
    return { secret: toBase64(kp.secretKey), public: toBase64(kp.publicKey) };
  }

  static fromStored(stored: StoredRootKey, options: AuthorityOptions = {}): WorkspaceAuthority {
    return new WorkspaceAuthority(
      { secretKey: fromBase64(stored.secret), publicKey: fromBase64(stored.public) },
      options,
    );
  }

  /** The capability of one user in this workspace, for their user session. */
  mintUser(user: string): string {
    if (!NAME.test(user)) throw codedError("EINVAL", "invalid user name");
    return Biscuit.build(this.#keys.secretKey, "user({user});", { params: { user } }).toBase64();
  }

  async #verify(capability: string): Promise<VerifiedBiscuit> {
    let verified: VerifiedBiscuit;
    try {
      verified = await Biscuit.fromBase64(capability).verifyAsync(this.#keys.publicKey);
    } catch {
      throw codedError("EACCES", "invalid capability");
    }
    if (this.#isRevoked(verified.revocationIds)) throw codedError("EACCES", "revoked capability");
    return verified;
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
   * The user of a bare user capability (the one a user session holds); an agent session's, or
   * any other attenuated capability, is refused, so only a user session manages what is the user's.
   */
  async userOfUserCapability(capability: string): Promise<string> {
    const verified = await this.#verify(capability);
    if (verified.token.blocks.length !== 1) throw codedError("EACCES", "not a user capability");
    return this.#userOf(verified);
  }

  /**
   * The revocation id that revokes `capability` (its last block), for the holder of a bare user
   * capability: only a capability narrowed from that very user capability (the same authority
   * block, so the same user session) is named, the user capability itself included. Putting the id
   * on the revocation list stops the capability and every one narrowed from it.
   */
  async revocationOf(userCapability: string, capability: string): Promise<string> {
    const owner = await this.#verify(userCapability);
    if (owner.token.blocks.length !== 1) throw codedError("EACCES", "not a user capability");
    const target = await this.#verify(capability);
    const ids = target.revocationIds;
    if (ids[0] !== owner.revocationIds[0])
      throw codedError("EACCES", "not a capability of this user session");
    return ids[ids.length - 1] as string;
  }

  /**
   * What an agent session's capability says: the user from its root-signed authority block, and
   * the session, project and agent from its first attenuation block, which the User DO
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
    const unattended = block.facts.some((f) => {
      const t = f.predicate.terms[0] as Term | undefined;
      return (
        f.predicate.name === "unattended" &&
        f.predicate.terms.length === 1 &&
        t?.t === "bool" &&
        t.v === true
      );
    });
    const project = String(values.project);
    if (!NAME.test(project)) throw codedError("EACCES", "not an agent session's capability");
    const facts: AgentSessionFacts = {
      user,
      session: String(values.agent_session),
      project,
      agent: String(values.agent),
      unattended,
    };
    // Sub-agent blocks: only those the workspace signed count, each naming the session before it
    // as its parent. A block the holder appended is a check at most, never a fact the gate reads.
    const lineage: string[] = [];
    const modes: string[] = [];
    for (const later of verified.token.blocks.slice(2)) {
      if (later.externalKey !== this.#externalKey) continue;
      // A tool's capability is narrowed no further by the workspace.
      if (facts.tool) throw codedError("EACCES", "not an agent session's capability");
      if (later.facts.some((f) => f.predicate.name === "tool_plugin")) {
        const tool: Record<string, string> = {};
        for (const name of TOOL_FACTS) {
          const found = later.facts.filter((f) => f.predicate.name === name);
          const t = found[0]?.predicate.terms[0] as Term | undefined;
          if (found.length !== 1 || found[0]?.predicate.terms.length !== 1 || t?.t !== "str")
            throw codedError("EACCES", "not an agent session's capability");
          tool[name] = t.v;
        }
        facts.tool = { plugin: String(tool.tool_plugin), tool: String(tool.tool_name) };
        continue;
      }
      const sub: Record<string, string> = {};
      for (const name of SUB_AGENT_FACTS) {
        const found = later.facts.filter((f) => f.predicate.name === name);
        const t = found[0]?.predicate.terms[0] as Term | undefined;
        if (found.length !== 1 || found[0]?.predicate.terms.length !== 1 || t?.t !== "str")
          throw codedError("EACCES", "not an agent session's capability");
        sub[name] = t.v;
      }
      if (sub.parent_session !== facts.session)
        throw codedError("EACCES", "not an agent session's capability");
      for (const f of later.facts.filter((f) => f.predicate.name === "mode")) {
        const t = f.predicate.terms[0] as Term | undefined;
        // An unreadable mode is kept as it is: the gate knows no such mode, and denies.
        modes.push(t?.t === "str" ? t.v : "");
      }
      lineage.push(facts.session);
      facts.session = String(sub.agent_session);
      facts.agent = String(sub.agent);
      facts.parent = String(sub.parent_session);
    }
    if (lineage.length) facts.lineage = lineage;
    if (modes.length) facts.modes = modes;
    return facts;
  }

  /**
   * The capability of a sub-agent of an agent session (statewalker/statewalker-root#126): the
   * parent's capability with one more block, which this workspace signs, naming the child's
   * session and agent (and a mode that may only be stricter). Only the user session that the
   * parent's capability was narrowed from may ask, with its own user capability. The child holds
   * every block of its parent's, so it can do nothing its parent can't, and revoking any ancestor
   * stops it.
   */
  async delegate(
    userCapability: string,
    parentCapability: string,
    grant: SubAgentGrant,
  ): Promise<string> {
    const owner = await this.#verify(userCapability);
    if (owner.token.blocks.length !== 1) throw codedError("EACCES", "not a user capability");
    const parent = await this.agentSessionOf(parentCapability);
    const target = await this.#verify(parentCapability);
    if (target.revocationIds[0] !== owner.revocationIds[0])
      throw codedError("EACCES", "not a capability of this user session");
    if (!NAME.test(grant.session) || grant.session === parent.session)
      throw codedError("EINVAL", "invalid session id");
    if (typeof grant.agent !== "string" || !grant.agent)
      throw codedError("EINVAL", "agent must be an agent's name");
    const modes = grant.modes ?? [];
    if (!modes.every((m) => typeof m === "string" && MODE_NAME.test(m)))
      throw codedError("EINVAL", "invalid mode name");
    const token = Biscuit.fromBase64(parentCapability);
    const block = thirdPartyBlock(
      token.thirdPartyRequest(),
      this.#keys.secretKey,
      SUB_AGENT_BLOCK + modes.map((_, i) => `\nmode({mode${i}});`).join(""),
      0,
      {
        session: grant.session,
        parent: parent.session,
        agent: grant.agent,
        ...Object.fromEntries(modes.map((m, i) => [`mode${i}`, m])),
      },
    );
    return token.appendThirdParty(block).toBase64();
  }

  /**
   * The capability of one plugin tool of an agent session (statewalker/statewalker-root#81): the
   * session's capability with one more block, which this workspace signs, naming the plugin and
   * the tool. It reaches what the session reaches, and the plugin's own databases besides; the
   * agent never holds it. The caller (the Workspace DO) checks the tool is one the session may call.
   */
  async forTool(agentCapability: string, grant: ToolGrant): Promise<string> {
    const facts = await this.agentSessionOf(agentCapability);
    if (facts.tool) throw codedError("EACCES", "a tool's capability is narrowed no further");
    if (!PLUGIN_NAME.test(String(grant.plugin)) || !TOOL_NAME.test(String(grant.tool)))
      throw codedError("EINVAL", "a tool is named by its plugin and its name");
    const token = Biscuit.fromBase64(agentCapability);
    const block = thirdPartyBlock(token.thirdPartyRequest(), this.#keys.secretKey, TOOL_BLOCK, 0, {
      plugin: grant.plugin,
      tool: grant.tool,
    });
    return token.appendThirdParty(block).toBase64();
  }

  /**
   * Authorizes one database action under a capability: allowed when one of the member's roles
   * grants `db.<action>` on the database's name, within that role's checks, and every block of the
   * capability agrees (an agent session's binds it to its own project); EACCES otherwise.
   */
  async authorizeDatabase(capability: string, req: DatabaseRequest): Promise<void> {
    let ok = false;
    try {
      const verified = await this.#verify(capability);
      if (!NAME.test(req.project)) throw codedError("EACCES", "no such project");
      const extra = { code: DATABASE_FACTS, params: { root: `/${req.project}/` } };
      ok = req.grants.some((grant) => {
        const { code, params } = roleAuthorizer(
          grant,
          { area: "db", action: req.action, target: req.database },
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
    if (!ok) throw codedError("EACCES", `may not ${req.action} database '${req.database}'`);
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
