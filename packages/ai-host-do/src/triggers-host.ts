// Triggers' host side (statewalker/statewalker-root#207, decision #160): the triggers of one
// workspace, kept by its Workspace DO, as consumers of the projects' task queues.
//
// - A trigger has its own subscription (`trigger.<name>`) on its own server-only subject:
//   `schedule.<name>` for a schedule, `hooks.<name>` for a webhook or a manual trigger. Every fire
//   publishes one task there (the payload `{source, data}`), and the trigger claims its tasks while
//   fewer than `max_concurrent` of its turns run; it acks them when the turn ends.
// - A fire runs as the trigger's owner (a user or a service account) with their roles, mode rules
//   and standing now: unattended, in the trigger's mode, charged to them. An owner who was revoked,
//   deleted, removed from the project or lost the agent suspends the trigger with the reason.
// - Rights: `triggers.write:own` for one's own triggers, `triggers.write:project` (project owners,
//   the workspace admin) for service accounts' triggers, and disabling or deleting anyone's; no
//   one else changes what another user's trigger runs. A non-member sees no trigger.
// - Webhooks: an HMAC over `<timestamp>.<body>` with the trigger's secret (kept sealed in the
//   secret store, shown once), the timestamp within 5 minutes and each signature taken once; or the
//   owner service account's access token. `Idempotency-Key` returns the first result for 24 hours.
//   Only where the deployment is publicly reachable (not CellB in a browser).
import {
  codedError,
  codeOf,
  decide,
  isServiceAccount,
  type RoleGrant,
} from "@statewalker/ai-access";
import type { Limit } from "@statewalker/ai-environment";
import { KeyedLock } from "@statewalker/ai-memory";
import {
  checkSchedule,
  dueFires,
  type FireResult,
  type FireSource,
  HOOK_SIGNATURE_HEADER,
  HOOK_TIMESTAMP_HEADER,
  HOOK_WINDOW_MS,
  hookSignature,
  nextFire,
  sameText,
  TERMINAL_TURN_STATUSES,
  type TriggerFire,
  type TriggerKind,
  type TriggerSchedule,
  type TriggersCall,
  type TriggerTarget,
  type TriggerView,
  triggerMessage,
} from "@statewalker/ai-sessions";
import type { Lease, QueueReader, SqlLike } from "@statewalker/ai-tasks";
import type { TasksHost } from "./tasks-host.js";

const MIN = 60_000;
const DAY = 86_400_000;
/** A fire's lease on its tasks, renewed while its turn runs. */
export const FIRE_LEASE_MS = 10 * MIN;
/** A new session of a trigger is archived this long after its fire. */
export const ARCHIVE_AFTER_MS = 30 * DAY;
const IDEMPOTENCY_MS = DAY;
const MAX_CONCURRENT = 10;
const MAX_MESSAGE = 32 * 1024;
/** Fires kept per trigger. */
const MAX_HISTORY = 500;
/** Tasks a session target takes at once. */
const MAX_BATCH = 100;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KINDS: readonly TriggerKind[] = ["schedule", "webhook", "manual"];

/** The deployment's TRIGGERS setting. */
export interface TriggerSettings {
  /** The shortest interval between a cron schedule's fires (15 minutes by default). */
  minIntervalMs: number;
  /** Whether a trigger may run in `bypassPermissions` (no by default). */
  allowBypass: boolean;
  /** Whether webhooks are offered: only on a publicly reachable deployment. */
  webhooks: boolean;
  /** A fire's payload cap (the queue's, 64 KB by default). */
  maxPayloadBytes: number;
}

/** The deployment's TRIGGERS setting (JSON `{min_interval_minutes?, allow_bypass_permissions?, webhooks?}`). */
export function triggerSettings(
  text: string | undefined,
  defaults: { webhooks: boolean; maxPayloadBytes: number },
): TriggerSettings {
  let v: Record<string, unknown> = {};
  try {
    v = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    console.warn("TRIGGERS: not JSON");
  }
  const minutes = Number(v.min_interval_minutes);
  return {
    minIntervalMs: Number.isFinite(minutes) && minutes > 0 ? minutes * MIN : 15 * MIN,
    allowBypass: v.allow_bypass_permissions === true,
    webhooks: defaults.webhooks && v.webhooks !== false,
    maxPayloadBytes: defaults.maxPayloadBytes,
  };
}

/** What a fire asks for a new session. */
export interface StartFire {
  owner: string;
  project: string;
  agent?: string;
  model?: string;
  limits?: Limit[];
  mode: string;
  metadata: Record<string, string>;
  message: string;
}

export interface TriggersHostOptions {
  sql: SqlLike;
  workspace: string;
  now(): number;
  tasks: TasksHost;
  settings: TriggerSettings;
  access(project: string, user: string): Promise<{ member: boolean; grants: RoleGrant[] }>;
  workspaceGrants(user: string): Promise<RoleGrant[]>;
  isMode(name: string): boolean;
  /** Whether the owner may start sessions on the agent in the project now. */
  mayUseAgent(project: string, owner: string, agent: string): Promise<boolean>;
  /** Why the owner may no longer act anywhere (revoked, a deleted service account), or undefined. */
  standing(owner: string): Promise<string | undefined>;
  /** The user of a valid access token for this workspace; EAUTH otherwise. */
  tokenUser(token: string): Promise<string>;
  secrets: {
    set(project: string, name: string, value: string): Promise<void>;
    open(project: string, name: string): Promise<string | undefined>;
    delete(project: string, name: string): void;
  };
  /** Starts a new session as the owner and sends its first message: its id and the turn. */
  start(req: StartFire): Promise<{ session: string; turn: string }>;
  /** Sends a message to one of the owner's (unattended) sessions: the turn. */
  send(req: { owner: string; project: string; session: string; message: string }): Promise<{
    turn: string;
  }>;
  /** A turn's status and cost now (undefined: no such turn). */
  turnState(session: string, turn: string): Promise<{ status: string; cost?: number } | undefined>;
  /** Archives one of the owner's sessions (a trigger's new session after its time). */
  archive(owner: string, session: string): Promise<void>;
  arm(at: number | undefined): Promise<void>;
}

interface Def {
  schedule?: TriggerSchedule;
  agent?: string;
  target: TriggerTarget;
  message: string;
  mode: string;
  model?: string;
  max_concurrent: number;
  limits?: Limit[];
}

interface Row {
  id: string;
  project: string;
  name: string;
  kind: TriggerKind;
  owner: string;
  created_by: string;
  def: string;
  enabled: number;
  suspended: string | null;
  next_fire: number | null;
  created: number;
  updated: number;
}

interface FireRow {
  id: string;
  trigger: string;
  project: string;
  time: number;
  source: string;
  outcome: string;
  session: string | null;
  turn: string | null;
  tasks: string | null;
  leases: string | null;
  running: number;
  turn_status: string | null;
  cost: number | null;
  reason: string | null;
  ended: number | null;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw codedError("EINVAL", `${what} is required`);
  return v;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const hex = (n: number) =>
  [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const iso = (t: number) => new Date(t).toISOString();

const subjectOf = (kind: TriggerKind, name: string) =>
  kind === "schedule" ? `schedule.${name}` : `hooks.${name}`;

const subscriptionOf = (name: string) => `trigger.${name}`;

const holderOf = (id: string) => `trigger:${id}`;

const secretNameOf = (id: string) => `HOOK_${id.slice(id.lastIndexOf(".") + 1)}`;

const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v ?? null)).length;

export class TriggersHost {
  readonly #o: TriggersHostOptions;
  /** One dispatch per trigger at a time: its running count holds across the awaits of a start. */
  readonly #locks = new KeyedLock();

  constructor(o: TriggersHostOptions) {
    this.#o = o;
    o.sql.exec(`CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, project TEXT NOT NULL,
      name TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, created_by TEXT NOT NULL,
      def TEXT NOT NULL, enabled INTEGER NOT NULL, suspended TEXT, next_fire INTEGER,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, UNIQUE (project, name))`);
    o.sql.exec(`CREATE TABLE IF NOT EXISTS trigger_fires (id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL, project TEXT NOT NULL, time INTEGER NOT NULL, source TEXT NOT NULL,
      outcome TEXT NOT NULL, session TEXT, turn TEXT, tasks TEXT, leases TEXT,
      running INTEGER NOT NULL DEFAULT 0, turn_status TEXT, cost REAL, reason TEXT, ended INTEGER)`);
    // A new session's archiving, kept apart from the history: deleting the trigger or trimming its
    // history never keeps a session from being archived after its 30 days.
    o.sql.exec(`CREATE TABLE IF NOT EXISTS trigger_archives (session TEXT PRIMARY KEY,
      owner TEXT NOT NULL, archive_at INTEGER NOT NULL)`);
    o.sql.exec(
      "CREATE INDEX IF NOT EXISTS trigger_fires_by_trigger ON trigger_fires (trigger, time)",
    );
    o.sql.exec(`CREATE TABLE IF NOT EXISTS trigger_hook_seen (trigger TEXT NOT NULL,
      signature TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (trigger, signature))`);
    o.sql.exec(`CREATE TABLE IF NOT EXISTS trigger_idempotency (trigger TEXT NOT NULL,
      key TEXT NOT NULL, result TEXT NOT NULL, expires INTEGER NOT NULL,
      PRIMARY KEY (trigger, key))`);
  }

  #rows<T>(query: string, ...args: unknown[]): T[] {
    return this.#o.sql.exec(query, ...args).toArray() as unknown as T[];
  }

  #row(id: string): Row | undefined {
    return this.#rows<Row>("SELECT * FROM triggers WHERE id = ?", id)[0];
  }

  #def(row: Row): Def {
    return JSON.parse(row.def) as Def;
  }

  #view(row: Row): TriggerView {
    const def = this.#def(row);
    return {
      id: row.id,
      project: row.project,
      name: row.name,
      kind: row.kind,
      subscription: subscriptionOf(row.name),
      subject: subjectOf(row.kind, row.name),
      ...(def.schedule ? { schedule: def.schedule } : {}),
      ...(def.agent ? { agent: def.agent } : {}),
      target: def.target,
      message: def.message,
      mode: def.mode,
      ...(def.model ? { model: def.model } : {}),
      max_concurrent: def.max_concurrent,
      ...(def.limits?.length ? { limits: def.limits } : {}),
      owner: row.owner,
      created_by: row.created_by,
      enabled: Boolean(row.enabled),
      ...(row.suspended ? { suspended: JSON.parse(row.suspended) } : {}),
      ...(row.next_fire !== null && row.enabled && !row.suspended
        ? { next_fire: Number(row.next_fire) }
        : {}),
      ...(row.kind === "webhook" ? { hook_path: `/v1/hooks/${row.id}` } : {}),
      created: Number(row.created),
      updated: Number(row.updated),
    };
  }

  #fireView(r: FireRow): TriggerFire {
    return {
      id: r.id,
      trigger: r.trigger,
      time: Number(r.time),
      source: r.source as FireSource,
      outcome: r.outcome as TriggerFire["outcome"],
      ...(r.session ? { session: r.session } : {}),
      ...(r.turn ? { turn: r.turn } : {}),
      ...(r.turn_status ? { turn_status: r.turn_status } : {}),
      ...(r.cost !== null && r.cost !== undefined ? { cost: Number(r.cost) } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.tasks ? { tasks: JSON.parse(r.tasks) as string[] } : {}),
      ...(r.ended ? { ended: Number(r.ended) } : {}),
    };
  }

  /** A caller's trigger rights in a project, now. */
  async #rights(user: string, project: string) {
    const access = await this.#o.access(project, user).catch(() => undefined);
    const member = !!access?.member;
    const grants = access?.grants ?? [];
    const may = (target: string) =>
      member && decide(grants, { area: "triggers", action: "write", target });
    const admin = decide(await this.#o.workspaceGrants(user).catch(() => []), {
      area: "triggers",
      action: "write",
      target: "project",
    });
    const projectWide = may("project") || admin;
    return { member, own: may("own") || may("project"), project: projectWide };
  }

  /** A trigger the caller sees: its owner, or a holder of `triggers.write:project`. */
  async #visible(user: string, project: string, id: unknown) {
    const row = this.#row(str(id, "trigger"));
    const rights = await this.#rights(user, project);
    if (!row || row.project !== project || !(row.owner === user || rights.project))
      throw codedError("ENOENT", "no such trigger");
    // Changing what it runs: its owner, or for a service account's, a project manager.
    const full =
      (row.owner === user && rights.own) || (isServiceAccount(row.owner) && rights.project);
    return { row, rights, full };
  }

  /** One trigger API call with the caller's rights now. */
  async call(user: string, raw: TriggersCall): Promise<unknown> {
    const args = Array.isArray(raw?.args) ? raw.args : [];
    switch (raw?.op) {
      case "listTriggers": {
        const project = str(args[0], "project");
        const rights = await this.#rights(user, project);
        if (!rights.member && !rights.project) throw codedError("ENOENT", "no such project");
        return {
          triggers: this.#rows<Row>(
            "SELECT * FROM triggers WHERE project = ? ORDER BY name",
            project,
          )
            .filter((r) => r.owner === user || rights.project)
            .map((r) => this.#view(r)),
        };
      }
      case "createTrigger":
        return this.#create(user, str(args[0], "project"), obj(args[1]));
      case "getTrigger": {
        const { row } = await this.#visible(user, str(args[0], "project"), args[1]);
        return this.#view(row);
      }
      case "updateTrigger":
        return this.#update(user, str(args[0], "project"), args[1], obj(args[2]));
      case "deleteTrigger": {
        const { row, rights, full } = await this.#visible(user, str(args[0], "project"), args[1]);
        if (!full && !rights.project) throw codedError("EACCES", "may not delete this trigger");
        await this.#drop(row);
        return { deleted: true, id: row.id, owner: row.owner };
      }
      case "triggerFires": {
        const { row } = await this.#visible(user, str(args[0], "project"), args[1]);
        const limit = Math.min(Math.max(Number(obj(args[2]).limit) || 50, 1), MAX_HISTORY);
        return {
          fires: this.#rows<FireRow>(
            "SELECT * FROM trigger_fires WHERE trigger = ? ORDER BY time DESC, rowid DESC LIMIT ?",
            row.id,
            limit,
          ).map((r) => this.#fireView(r)),
        };
      }
      case "fireTrigger": {
        const row = this.#row(str(args[0], "trigger"));
        if (!row) throw codedError("ENOENT", "no such trigger");
        const { full } = await this.#visible(user, row.project, row.id);
        if (!full) throw codedError("EACCES", "only its owner fires this trigger");
        const text = obj(args[1]).text;
        if (text !== undefined && typeof text !== "string")
          throw codedError("EINVAL", "text is a string");
        this.#firable(row);
        return this.#publish(row, "manual", text === undefined || text === "" ? undefined : text);
      }
      default:
        throw codedError("EINVAL", `'${String(raw?.op)}' is not a trigger API method`);
    }
  }

  /** The owner a create names: the caller, or a service account of this workspace. */
  #ownerOf(user: string, raw: unknown): string {
    if (raw === undefined || raw === user) return user;
    if (typeof raw !== "string" || !raw) throw codedError("EINVAL", "owner is a name");
    if (isServiceAccount(raw)) return raw;
    const svc = `${raw}@${this.#o.workspace}.svc`;
    if (!isServiceAccount(svc))
      throw codedError("EINVAL", "owner is the caller or a service account");
    return svc;
  }

  #checkMode(mode: string): void {
    if (!this.#o.isMode(mode)) throw codedError("EINVAL", `no mode '${mode}'`);
    if (mode === "bypassPermissions" && !this.#o.settings.allowBypass)
      throw codedError("EACCES", "this deployment does not allow triggers in bypassPermissions");
  }

  /** A definition's fields, checked; `base` holds what a patch leaves as it was. */
  #checkDef(input: Record<string, unknown>, base?: Def): Def {
    const pick = <T>(key: string, fallback: T): T =>
      (input[key] === undefined ? fallback : input[key]) as T;
    const message = pick<unknown>("message", base?.message);
    if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE)
      throw codedError("EINVAL", `message is the instruction, at most ${MAX_MESSAGE} characters`);
    const mode = pick<unknown>("mode", base?.mode ?? "default");
    if (typeof mode !== "string") throw codedError("EINVAL", "mode is a mode's name");
    this.#checkMode(mode);
    const target = pick<unknown>("target", base?.target ?? "new_session");
    if (
      target !== "new_session" &&
      !(typeof target === "string" && /^session:as-[A-Za-z0-9-]{1,64}$/.test(target))
    )
      throw codedError("EINVAL", "target is new_session or session:<id>");
    const max = pick<unknown>("max_concurrent", base?.max_concurrent ?? 1);
    if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > MAX_CONCURRENT)
      throw codedError("EINVAL", `max_concurrent is 1 to ${MAX_CONCURRENT}`);
    const agent = pick<unknown>("agent", base?.agent);
    if (agent !== undefined && (typeof agent !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(agent)))
      throw codedError("EINVAL", "agent is <plugin>/<agent>");
    const model = pick<unknown>("model", base?.model);
    if (model !== undefined && (typeof model !== "string" || !model))
      throw codedError("EINVAL", "model is a model's id or alias");
    const limits = pick<unknown>("limits", base?.limits);
    if (limits !== undefined && !Array.isArray(limits))
      throw codedError("EINVAL", "limits is a list of limits");
    return {
      ...(base?.schedule ? { schedule: base.schedule } : {}),
      ...(agent ? { agent: agent as string } : {}),
      target: target as TriggerTarget,
      message,
      mode,
      ...(model ? { model: model as string } : {}),
      max_concurrent: max as number,
      ...(Array.isArray(limits) && limits.length ? { limits: limits as Limit[] } : {}),
    };
  }

  async #create(user: string, project: string, input: Record<string, unknown>) {
    const rights = await this.#rights(user, project);
    if (!rights.member && !rights.project) throw codedError("ENOENT", "no such project");
    const owner = this.#ownerOf(user, input.owner);
    if (owner === user) {
      if (!rights.own) throw codedError("EACCES", "creating a trigger takes triggers.write:own");
    } else {
      if (!rights.project)
        throw codedError(
          "EACCES",
          "a trigger owned by a service account takes triggers.write:project",
        );
      const standing = await this.#o.standing(owner);
      if (standing) throw codedError("EINVAL", standing);
    }
    if (!(await this.#o.access(project, owner).catch(() => undefined))?.member)
      throw codedError("EINVAL", `${owner} is not a member of ${project}`);
    const name = input.name;
    if (typeof name !== "string" || !NAME.test(name))
      throw codedError("EINVAL", "name is lowercase letters, digits, _ and -, at most 64");
    const kind = input.kind as TriggerKind;
    if (!KINDS.includes(kind)) throw codedError("EINVAL", "kind is schedule, webhook or manual");
    if (this.#rows("SELECT 1 FROM triggers WHERE project = ? AND name = ?", project, name).length)
      throw codedError("EEXIST", `a trigger '${name}' exists in ${project}`);
    const now = this.#o.now();
    let def = this.#checkDef(input);
    let next: number | undefined;
    if (kind === "schedule") {
      const checked = checkSchedule(input.schedule, now, this.#o.settings.minIntervalMs);
      def = { ...def, schedule: checked.schedule };
      next = checked.next;
    } else if (input.schedule !== undefined)
      throw codedError("EINVAL", "only a schedule trigger takes a schedule");
    if (kind === "webhook" && !this.#o.settings.webhooks)
      throw codedError(
        "ENOSYS",
        "webhooks need a publicly reachable deployment, which this one is not",
      );
    if (def.agent && !(await this.#o.mayUseAgent(project, owner, def.agent)))
      throw codedError("EACCES", `${owner} may not use the agent ${def.agent} in ${project}`);
    const enabled = input.enabled === undefined ? true : input.enabled === true;
    const id = `${this.#o.workspace}.${hex(12)}`;
    let secret: string | undefined;
    if (kind === "webhook") {
      secret = `whsec_${hex(32)}`;
      await this.#o.secrets.set(project, secretNameOf(id), secret);
    }
    try {
      await this.#ensureSubscription(project, name, kind, id);
    } catch (e) {
      if (secret) this.#o.secrets.delete(project, secretNameOf(id));
      throw e;
    }
    this.#o.sql.exec(
      "INSERT INTO triggers VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
      id,
      project,
      name,
      kind,
      owner,
      user,
      JSON.stringify(def),
      enabled ? 1 : 0,
      next ?? null,
      now,
      now,
    );
    await this.#arm();
    const view = this.#view(this.#row(id) as Row);
    return secret ? { ...view, secret } : view;
  }

  async #ensureSubscription(project: string, name: string, kind: TriggerKind, id: string) {
    await this.#o.tasks.server(project, (q) => {
      try {
        const sub = q.getSubscription(project, subscriptionOf(name));
        if (sub.owner === holderOf(id)) return;
      } catch (e) {
        if (codeOf(e) !== "ENOENT") throw e;
        q.subscribe(
          project,
          {
            name: subscriptionOf(name),
            filter: { subject: subjectOf(kind, name) },
            lease_ms: FIRE_LEASE_MS,
          },
          holderOf(id),
        );
        return;
      }
      throw codedError("EEXIST", `the subscription '${subscriptionOf(name)}' is taken`);
    });
  }

  async #update(user: string, project: string, id: unknown, patch: Record<string, unknown>) {
    const { row, rights, full } = await this.#visible(user, project, id);
    for (const key of ["name", "kind", "owner"])
      if (
        patch[key] !== undefined &&
        patch[key] !== (row as unknown as Record<string, unknown>)[key]
      )
        throw codedError("EINVAL", `a trigger's ${key} does not change`);
    const onlyDisable = Object.keys(patch).every((k) => k === "enabled") && patch.enabled === false;
    if (!full && !(rights.project && onlyDisable))
      throw codedError("EACCES", "only its owner changes this trigger; you may disable it");
    const now = this.#o.now();
    const base = this.#def(row);
    // Disabling never fails on a definition the deployment no longer accepts (a mode it dropped).
    let def = onlyDisable ? base : this.#checkDef(patch, base);
    let next = row.next_fire === null ? undefined : Number(row.next_fire);
    if (patch.schedule !== undefined) {
      if (row.kind !== "schedule")
        throw codedError("EINVAL", "only a schedule trigger takes a schedule");
      const checked = checkSchedule(patch.schedule, now, this.#o.settings.minIntervalMs);
      def = { ...def, schedule: checked.schedule };
      next = checked.next;
    }
    if (
      patch.agent !== undefined &&
      def.agent &&
      !(await this.#o.mayUseAgent(project, row.owner, def.agent))
    )
      throw codedError("EACCES", `${row.owner} may not use the agent ${def.agent} in ${project}`);
    let enabled = Boolean(row.enabled);
    let suspended = row.suspended;
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw codedError("EINVAL", "enabled is a boolean");
      // Enabling again clears a suspension; a schedule fires from now on, not what it missed.
      if (patch.enabled && (!enabled || suspended)) {
        suspended = null;
        if (def.schedule) next = nextFire(def.schedule, now);
      }
      enabled = patch.enabled;
    }
    this.#o.sql.exec(
      "UPDATE triggers SET def = ?, enabled = ?, suspended = ?, next_fire = ?, updated = ? WHERE id = ?",
      JSON.stringify(def),
      enabled ? 1 : 0,
      suspended,
      next ?? null,
      now,
      row.id,
    );
    const updated = this.#row(row.id) as Row;
    if (enabled && !suspended) await this.#dispatch(updated);
    await this.#arm();
    return this.#view(this.#row(row.id) as Row);
  }

  async #drop(row: Row): Promise<void> {
    await this.#o.tasks
      .server(row.project, (q) => {
        try {
          if (q.getSubscription(row.project, subscriptionOf(row.name)).owner === holderOf(row.id))
            q.unsubscribe(row.project, subscriptionOf(row.name));
        } catch {
          // Gone already.
        }
      })
      .catch(() => {});
    if (row.kind === "webhook") this.#o.secrets.delete(row.project, secretNameOf(row.id));
    for (const table of ["trigger_hook_seen", "trigger_idempotency"])
      this.#o.sql.exec(`DELETE FROM ${table} WHERE trigger = ?`, row.id);
    this.#o.sql.exec("DELETE FROM trigger_fires WHERE trigger = ?", row.id);
    this.#o.sql.exec("DELETE FROM triggers WHERE id = ?", row.id);
  }

  /** Forgets a deleted project's triggers. */
  async dropProject(project: string): Promise<void> {
    for (const row of this.#rows<Row>("SELECT * FROM triggers WHERE project = ?", project)) {
      if (row.kind === "webhook") this.#o.secrets.delete(row.project, secretNameOf(row.id));
      for (const table of ["trigger_hook_seen", "trigger_idempotency", "trigger_fires"])
        this.#o.sql.exec(`DELETE FROM ${table} WHERE trigger = ?`, row.id);
    }
    this.#o.sql.exec("DELETE FROM triggers WHERE project = ?", project);
  }

  /** EBUSY for a trigger that does not fire now. */
  #firable(row: Row): void {
    if (row.suspended)
      throw codedError("EBUSY", `the trigger is suspended: ${JSON.parse(row.suspended).reason}`);
    if (!row.enabled) throw codedError("EBUSY", "the trigger is disabled");
  }

  /** Publishes one fire's task, then lets the trigger take what it may now. */
  async #publish(row: Row, source: FireSource, data: unknown): Promise<FireResult> {
    const payload = { source, ...(data !== undefined ? { data } : {}) };
    const bytes = bytesOf(payload);
    if (bytes > this.#o.settings.maxPayloadBytes)
      throw codedError(
        "E2BIG",
        `a fire's payload is at most ${this.#o.settings.maxPayloadBytes} bytes`,
      );
    await this.#ensureSubscription(row.project, row.name, row.kind, row.id);
    const task = await this.#o.tasks.server(
      row.project,
      (q) =>
        q.publish(
          row.project,
          { subject: subjectOf(row.kind, row.name), payload },
          holderOf(row.id),
        ),
      bytes,
    );
    await this.#dispatch(this.#row(row.id) as Row);
    await this.#arm();
    const fire = this.#rows<FireRow>(
      "SELECT f.* FROM trigger_fires f, json_each(f.tasks) t WHERE f.trigger = ? AND t.value = ? ORDER BY f.time DESC LIMIT 1",
      row.id,
      task.id,
    )[0];
    return { trigger: row.id, task: task.id, ...(fire ? { fire: this.#fireView(fire) } : {}) };
  }

  #running(row: Row): number {
    return Number(
      this.#rows<{ n: number }>(
        "SELECT count(*) AS n FROM trigger_fires WHERE trigger = ? AND running = 1",
        row.id,
      )[0]?.n ?? 0,
    );
  }

  #reader(row: Row): QueueReader {
    return { id: holderOf(row.id), destinations: [], may: () => true };
  }

  /** Takes the trigger's waiting tasks while fewer than `max_concurrent` of its turns run. */
  #dispatch(row: Row): Promise<void> {
    return this.#locks.run(row.id, () => this.#dispatchNow(row));
  }

  async #dispatchNow(row: Row): Promise<void> {
    for (;;) {
      const current = this.#row(row.id);
      if (!current?.enabled || current.suspended) return;
      const def = this.#def(current);
      if (this.#running(current) >= def.max_concurrent) return;
      const batch = def.target === "new_session" ? 1 : MAX_BATCH;
      let leases: Lease[];
      try {
        leases = await this.#o.tasks.server(current.project, (q) =>
          q.claim(current.project, subscriptionOf(current.name), this.#reader(current), {
            limit: batch,
            lease_ms: FIRE_LEASE_MS,
          }),
        );
      } catch {
        return;
      }
      if (!leases.length) return;
      if (!(await this.#fire(current, def, leases))) return;
    }
  }

  /** Why the owner may not fire the trigger now, or undefined. */
  async #lostAccess(row: Row, def: Def): Promise<string | undefined> {
    const standing = await this.#o.standing(row.owner).catch(() => undefined);
    if (standing) return standing;
    const access = await this.#o.access(row.project, row.owner).catch(() => undefined);
    if (!access?.member) return `${row.owner} is no longer a member of ${row.project}`;
    if (!this.#o.isMode(def.mode)) return `the deployment no longer has the mode '${def.mode}'`;
    if (def.mode === "bypassPermissions" && !this.#o.settings.allowBypass)
      return "the deployment no longer allows triggers in bypassPermissions";
    if (def.agent && !(await this.#o.mayUseAgent(row.project, row.owner, def.agent)))
      return `${row.owner} may no longer use the agent ${def.agent}`;
    return undefined;
  }

  #suspend(row: Row, reason: string): void {
    this.#o.sql.exec(
      "UPDATE triggers SET suspended = ? WHERE id = ?",
      JSON.stringify({ reason, at: this.#o.now() }),
      row.id,
    );
  }

  #record(row: Row, fire: Partial<FireRow> & { outcome: string; source: string; time: number }) {
    const id = `fire-${hex(10)}`;
    this.#o.sql.exec(
      `INSERT INTO trigger_fires (id, trigger, project, time, source, outcome, session, turn, tasks,
        leases, running, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      row.id,
      row.project,
      fire.time,
      fire.source,
      fire.outcome,
      fire.session ?? null,
      fire.turn ?? null,
      fire.tasks ?? null,
      fire.leases ?? null,
      fire.running ?? 0,
      fire.reason ?? null,
    );
    // The oldest fires go beyond the history's size; running ones stay.
    this.#o.sql.exec(
      `DELETE FROM trigger_fires WHERE trigger = ? AND running = 0 AND id NOT IN
        (SELECT id FROM trigger_fires WHERE trigger = ? ORDER BY time DESC, rowid DESC LIMIT ?)`,
      row.id,
      row.id,
      MAX_HISTORY,
    );
    return id;
  }

  async #releaseAll(row: Row, leases: Lease[], reason: string): Promise<void> {
    await this.#o.tasks
      .server(row.project, (q) => {
        for (const l of leases)
          try {
            q.release(l.id, holderOf(row.id), { reason });
          } catch {
            // The lease ran out meanwhile: its task waits again already.
          }
      })
      .catch(() => {});
  }

  /** Runs one fire on its claimed tasks; false when the trigger should take no more now. */
  async #fire(row: Row, def: Def, leases: Lease[]): Promise<boolean> {
    const now = this.#o.now();
    const tasks = leases.map((l) => l.task);
    const source = (obj(tasks[0]?.payload).source as FireSource) ?? "manual";
    const base = {
      time: now,
      source,
      tasks: JSON.stringify(tasks.map((t) => t.id)),
    };
    const lost = await this.#lostAccess(row, def);
    if (lost) {
      this.#suspend(row, lost);
      await this.#releaseAll(row, leases, `suspended: ${lost}`);
      this.#record(row, { ...base, outcome: "suspended", reason: lost });
      return false;
    }
    const message = triggerMessage(
      def.message,
      tasks.flatMap((t) => {
        const p = obj(t.payload);
        return p.data === undefined || p.data === null
          ? []
          : [{ source: String(p.source ?? "manual"), time: iso(t.created), payload: p.data }];
      }),
    );
    try {
      let session: string;
      let turn: string;
      if (def.target === "new_session") {
        const started = await this.#o.start({
          owner: row.owner,
          project: row.project,
          ...(def.agent ? { agent: def.agent } : {}),
          ...(def.model ? { model: def.model } : {}),
          ...(def.limits?.length ? { limits: def.limits } : {}),
          mode: def.mode,
          metadata: {
            title: `${row.name} · ${iso(now)}`,
            triggered_by: row.id,
            trigger_source: source,
          },
          message,
        });
        ({ session, turn } = started);
      } else {
        session = def.target.slice("session:".length);
        ({ turn } = await this.#o.send({
          owner: row.owner,
          project: row.project,
          session,
          message,
        }));
      }
      this.#record(row, {
        ...base,
        outcome: "started",
        session,
        turn,
        leases: JSON.stringify(leases.map((l) => l.id)),
        running: 1,
      });
      if (def.target === "new_session")
        this.#o.sql.exec(
          "INSERT OR REPLACE INTO trigger_archives VALUES (?, ?, ?)",
          session,
          row.owner,
          now + ARCHIVE_AFTER_MS,
        );
      // A turn that ended before its fire was recorded told no one: look once now.
      const state = await this.#o.turnState(session, turn).catch(() => undefined);
      if (state && TERMINAL_TURN_STATUSES.includes(state.status as never))
        await this.#endFire(session, turn, state.status, state.cost);
      return true;
    } catch (e) {
      const reason = String((e as Error)?.message ?? e);
      // A refusal of the owner's rights (membership, the agent, a revoked user session) suspends.
      if (codeOf(e) === "EACCES" || codeOf(e) === "EAUTH") {
        this.#suspend(row, reason);
        await this.#releaseAll(row, leases, `suspended: ${reason}`);
        this.#record(row, { ...base, outcome: "suspended", reason });
      } else {
        await this.#releaseAll(row, leases, reason);
        this.#record(row, { ...base, outcome: "failed", reason });
      }
      return false;
    }
  }

  /**
   * A turn of an unattended session ended (told by its DO): the fire it was acks its tasks, ends,
   * and the trigger takes what waits.
   */
  async turnEnded(session: string, turn: string, status: string, cost?: number): Promise<void> {
    const row = await this.#endFire(session, turn, status, cost);
    if (!row) return;
    await this.#dispatch(row);
    await this.#arm();
  }

  /** Ends the running fire of a turn and acks its tasks: its trigger, or undefined. */
  async #endFire(
    session: string,
    turn: string,
    status: string,
    cost?: number,
  ): Promise<Row | undefined> {
    const fire = this.#rows<FireRow>(
      "SELECT * FROM trigger_fires WHERE session = ? AND turn = ? AND running = 1",
      session,
      turn,
    )[0];
    if (!fire) return;
    this.#o.sql.exec(
      "UPDATE trigger_fires SET running = 0, turn_status = ?, cost = ?, ended = ? WHERE id = ?",
      status,
      cost ?? null,
      this.#o.now(),
      fire.id,
    );
    const row = this.#row(fire.trigger);
    if (!row) return;
    await this.#o.tasks
      .server(row.project, (q) => {
        for (const l of JSON.parse(fire.leases ?? "[]") as string[])
          try {
            q.ack(l, holderOf(row.id));
          } catch {
            // Its lease ran out: the task waits again, and runs again.
          }
      })
      .catch(() => {});
    return row;
  }

  /** A webhook request: authenticated before anything else, then published (202). */
  async hook(
    id: string,
    req: {
      body: string;
      headers: Record<string, string>;
      bearer?: string;
      idempotencyKey?: string;
    },
  ): Promise<FireResult> {
    const row = this.#row(String(id));
    if (row?.kind !== "webhook" || !this.#o.settings.webhooks)
      throw codedError("ENOENT", "no such webhook");
    const now = this.#o.now();
    if (req.bearer) {
      // The owner service account's own access token.
      const user = await this.#o.tokenUser(req.bearer).catch(() => undefined);
      if (!user || user !== row.owner || !isServiceAccount(user))
        throw codedError("EAUTH", "not this webhook's service account");
    } else {
      const timestamp = req.headers[HOOK_TIMESTAMP_HEADER] ?? "";
      const signature = req.headers[HOOK_SIGNATURE_HEADER] ?? "";
      if (!/^\d{1,12}$/.test(timestamp) || !signature)
        throw codedError("EAUTH", "a webhook request is signed (timestamp and signature)");
      if (Math.abs(now - Number(timestamp) * 1000) > HOOK_WINDOW_MS)
        throw codedError("EAUTH", "the webhook's timestamp is outside the 5 minutes allowed");
      const secret = await this.#o.secrets.open(row.project, secretNameOf(row.id));
      if (!secret) throw codedError("EAUTH", "the webhook has no secret");
      const expected = await hookSignature(secret, timestamp, req.body);
      if (!sameText(expected, signature)) throw codedError("EAUTH", "the signature does not match");
      this.#o.sql.exec("DELETE FROM trigger_hook_seen WHERE expires < ?", now);
      if (
        this.#rows(
          "SELECT 1 FROM trigger_hook_seen WHERE trigger = ? AND signature = ?",
          row.id,
          signature,
        ).length
      )
        throw codedError("EAUTH", "a replayed webhook request");
      this.#o.sql.exec(
        "INSERT INTO trigger_hook_seen VALUES (?, ?, ?)",
        row.id,
        signature,
        Number(timestamp) * 1000 + HOOK_WINDOW_MS,
      );
    }
    const key = req.idempotencyKey;
    if (key !== undefined) {
      if (!key || key.length > 256)
        throw codedError("EINVAL", "Idempotency-Key is 1 to 256 characters");
      this.#o.sql.exec("DELETE FROM trigger_idempotency WHERE expires < ?", now);
      const seen = this.#rows<{ result: string }>(
        "SELECT result FROM trigger_idempotency WHERE trigger = ? AND key = ?",
        row.id,
        key,
      )[0];
      if (seen) return JSON.parse(seen.result) as FireResult;
    }
    this.#firable(row);
    const result = await this.#publish(row, "webhook", req.body);
    if (key)
      this.#o.sql.exec(
        "INSERT OR IGNORE INTO trigger_idempotency VALUES (?, ?, ?, ?)",
        row.id,
        key,
        JSON.stringify(result),
        now + IDEMPOTENCY_MS,
      );
    return result;
  }

  /**
   * The alarm's work: schedules due (a missed fire recorded, the latest caught up per on_missed),
   * running fires' turns looked at (one that ended acks; one still running renews its leases), and
   * new sessions archived after 30 days.
   */
  async alarm(): Promise<void> {
    const now = this.#o.now();
    for (const row of this.#rows<Row>(
      "SELECT * FROM triggers WHERE kind = 'schedule' AND enabled = 1 AND suspended IS NULL AND next_fire IS NOT NULL AND next_fire <= ?",
      now,
    )) {
      const def = this.#def(row);
      if (!def.schedule) continue;
      const due = dueFires(def.schedule, Number(row.next_fire), now);
      for (const t of due.missed)
        this.#record(row, {
          time: t,
          source: "schedule",
          outcome: "missed",
          reason: "the host was not running",
        });
      this.#o.sql.exec("UPDATE triggers SET next_fire = ? WHERE id = ?", due.next ?? null, row.id);
      if (due.run !== undefined)
        await this.#publish(row, "schedule", { scheduled_at: iso(due.run) }).catch((e) => {
          this.#record(row, {
            time: now,
            source: "schedule",
            outcome: "failed",
            reason: String((e as Error)?.message ?? e),
          });
        });
    }
    for (const fire of this.#rows<FireRow>("SELECT * FROM trigger_fires WHERE running = 1")) {
      const state = await this.#o
        .turnState(String(fire.session), String(fire.turn))
        .catch(() => undefined);
      if (!state || TERMINAL_TURN_STATUSES.includes(state.status as never)) {
        await this.turnEnded(
          String(fire.session),
          String(fire.turn),
          state?.status ?? "failed",
          state?.cost,
        );
        continue;
      }
      const row = this.#row(fire.trigger);
      if (!row) continue;
      await this.#o.tasks
        .server(row.project, (q) => {
          for (const l of JSON.parse(fire.leases ?? "[]") as string[])
            try {
              q.renew(l, holderOf(row.id), { lease_ms: FIRE_LEASE_MS });
            } catch {
              // Lost: its task waits again.
            }
        })
        .catch(() => {});
    }
    for (const a of this.#rows<{ session: string; owner: string }>(
      "SELECT session, owner FROM trigger_archives WHERE archive_at <= ?",
      now,
    )) {
      await this.#o.archive(a.owner, a.session).catch(() => {});
      this.#o.sql.exec("DELETE FROM trigger_archives WHERE session = ?", a.session);
    }
    // Tasks waiting for a trigger that may take them (a free turn, a retry).
    for (const row of this.#rows<Row>(
      "SELECT * FROM triggers WHERE enabled = 1 AND suspended IS NULL",
    ))
      await this.#dispatch(row);
    await this.#arm();
  }

  /** The next time the alarm has work: a schedule, a running fire's lease, an archive. */
  async #arm(): Promise<void> {
    const times: number[] = [];
    const schedule = this.#rows<{ t: number | null }>(
      "SELECT min(next_fire) AS t FROM triggers WHERE enabled = 1 AND suspended IS NULL AND next_fire IS NOT NULL",
    )[0]?.t;
    if (schedule !== null && schedule !== undefined) times.push(Number(schedule));
    const archive = this.#rows<{ t: number | null }>(
      "SELECT min(archive_at) AS t FROM trigger_archives",
    )[0]?.t;
    if (archive !== null && archive !== undefined) times.push(Number(archive));
    if (this.#rows("SELECT 1 FROM trigger_fires WHERE running = 1 LIMIT 1").length)
      times.push(this.#o.now() + FIRE_LEASE_MS / 2);
    await this.#o.arm(times.length ? Math.min(...times) : undefined);
  }
}
