// Secrets (statewalker/statewalker-root#104, #133): credentials kept by the harness at four levels
// (deployment, workspace, project, user), the most specific winning. Deployment secrets are the
// runtime's own (environment variables the deployment declares); the others are rows of one table
// in the Workspace DO's SQLite, encrypted with a key derived from the deployment's `SECRETS_KEY`,
// never in files. Values are write-only: nothing here returns one except `resolve`, which only the
// host-side gateway calls, on each use, so a replaced secret applies to the next call.
//
// A secret's binding names the plugins that may use it and the hosts it may be sent to; a
// `{{secret:NAME}}` placeholder in an outgoing request resolves only when both match. The gateway
// puts values into headers and the URL at the last moment and redacts them from what it answers.
import { codedError } from "@statewalker/ai-access";
import {
  checkEgressUrl,
  type EgressConfig,
  type EgressTransport,
  internalAddress,
} from "./egress.js";
import type { SqlLike } from "./sql.js";

export type SecretLevel = "deployment" | "workspace" | "project" | "user";

/** The levels in the order they win: the most specific first. */
export const SECRET_LEVELS: readonly SecretLevel[] = ["user", "project", "workspace", "deployment"];

/** Which plugins may use a secret, and which hosts it may be sent to. */
export interface SecretBinding {
  plugins: string[];
  hosts: string[];
}

/** A secret as it may be shown: never its value. */
export interface SecretInfo {
  name: string;
  level: SecretLevel;
  /** The project of a project secret, or the user of a user secret ("" for workspace secrets). */
  scope: string;
  bindings: SecretBinding;
  updated: number;
}

/** A secret's value with its binding, as the gateway resolves it. */
export interface ResolvedSecret {
  name: string;
  level: SecretLevel;
  value: string;
  bindings: SecretBinding;
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PLUGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// A lowercase DNS name or an IPv4 address; hosts are matched exactly.
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_VALUE = 8192;
const MAX_BINDINGS = 32;
/** Runtime variables that are never deployment secrets, whatever the deployment declares. */
const NEVER_SECRETS = new Set(["SECRETS_KEY", "ADMIN_KEY", "DEPLOYMENT_SECRETS"]);

export function checkSecretName(name: unknown): string {
  if (typeof name !== "string" || !SECRET_NAME.test(name))
    throw codedError(
      "EINVAL",
      "a secret's name is letters, digits and _, not starting with a digit",
    );
  return name;
}

/** A binding as given, checked: at least one plugin and one host, each well-formed. */
export function checkBinding(bindings: unknown): SecretBinding {
  const b = (bindings ?? {}) as Partial<Record<keyof SecretBinding, unknown>>;
  const list = (v: unknown, what: string, re: RegExp, lower = false): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BINDINGS)
      throw codedError("EINVAL", `a secret's binding names 1 to ${MAX_BINDINGS} ${what}`);
    return [
      ...new Set(
        v.map((x) => {
          const s = typeof x === "string" ? (lower ? x.toLowerCase() : x) : "";
          if (!re.test(s))
            throw codedError("EINVAL", `'${String(x)}' is not one of a binding's ${what}`);
          return s;
        }),
      ),
    ];
  };
  return {
    plugins: list(b.plugins, "plugins", PLUGIN),
    hosts: list(b.hosts, "hosts", HOST, true),
  };
}

function checkValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_VALUE)
    throw codedError("EINVAL", `a secret's value is a string of 1 to ${MAX_VALUE} characters`);
  return value;
}

// ---- encryption ---------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The workspace's AES-GCM key, derived from the deployment's `SECRETS_KEY` with HKDF. */
async function workspaceKey(secretsKey: string, workspace: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secretsKey), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("statewalker-ai/secrets/v1"),
      info: enc.encode(workspace),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// The row's identity is the additional data, so a ciphertext copied to another row fails to open.
const aad = (level: string, scope: string, name: string) =>
  enc.encode(`${level}\0${scope}\0${name}`);

// ---- the store ----------------------------------------------------------------------------------

interface SecretRow {
  level: string;
  scope: string;
  name: string;
  sealed: string;
  bindings: string;
  updated: number;
}

export type StoredLevel = Exclude<SecretLevel, "deployment">;

/**
 * The workspace's secrets below deployment level: one table in the Workspace DO's SQLite, each
 * value sealed with AES-GCM under a key derived from `SECRETS_KEY` and the workspace's name.
 */
export class SecretStore {
  readonly #sql: SqlLike;
  readonly #key: Promise<CryptoKey> | undefined;

  constructor(options: { sql: SqlLike; secretsKey: string | undefined; workspace: string }) {
    this.#sql = options.sql;
    this.#key = options.secretsKey
      ? workspaceKey(options.secretsKey, options.workspace)
      : undefined;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS secrets (level TEXT NOT NULL, scope TEXT NOT NULL,
      name TEXT NOT NULL, sealed TEXT NOT NULL, bindings TEXT NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY (level, scope, name))`);
  }

  #keyOrFail(): Promise<CryptoKey> {
    if (!this.#key)
      throw codedError("ENOSYS", "this deployment keeps no secrets (SECRETS_KEY is not set)");
    return this.#key;
  }

  /** Sets or replaces a secret; the answer never holds its value. */
  async set(
    level: StoredLevel,
    scope: string,
    name: string,
    value: unknown,
    bindings: unknown,
  ): Promise<SecretInfo> {
    checkSecretName(name);
    const v = checkValue(value);
    const b = checkBinding(bindings);
    const key = await this.#keyOrFail();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(level, scope, name) },
        key,
        enc.encode(v),
      ),
    );
    const updated = Date.now();
    this.#sql.exec(
      "INSERT OR REPLACE INTO secrets VALUES (?, ?, ?, ?, ?, ?)",
      level,
      scope,
      name,
      `v1.${b64(iv)}.${b64(sealed)}`,
      JSON.stringify(b),
      updated,
    );
    return { name, level, scope, bindings: b, updated };
  }

  /** Deletes a secret; false when there was none. */
  delete(level: StoredLevel, scope: string, name: string): boolean {
    checkSecretName(name);
    const had = this.#row(level, scope, name) !== undefined;
    this.#sql.exec(
      "DELETE FROM secrets WHERE level = ? AND scope = ? AND name = ?",
      level,
      scope,
      name,
    );
    return had;
  }

  /** Deletes every secret of one scope of a level (a user's, when they are erased). */
  deleteScope(level: StoredLevel, scope: string): void {
    this.#sql.exec("DELETE FROM secrets WHERE level = ? AND scope = ?", level, scope);
  }

  /** The secrets of one scope of a level: names, bindings and update times. */
  list(level: StoredLevel, scope: string): SecretInfo[] {
    const rows = this.#sql
      .exec("SELECT * FROM secrets WHERE level = ? AND scope = ? ORDER BY name", level, scope)
      .toArray() as unknown as SecretRow[];
    return rows.map(infoOf);
  }

  #row(level: string, scope: string, name: string): SecretRow | undefined {
    return this.#sql
      .exec("SELECT * FROM secrets WHERE level = ? AND scope = ? AND name = ?", level, scope, name)
      .toArray()[0] as unknown as SecretRow | undefined;
  }

  /**
   * The values of one scope's secrets, opened now: only for the memory scan, which keeps any of
   * them out of memory (statewalker/statewalker-root#157). A value that does not open is left out.
   */
  async values(level: StoredLevel, scope: string): Promise<string[]> {
    const out: string[] = [];
    for (const info of this.list(level, scope)) {
      try {
        const secret = await this.open(level, scope, info.name);
        if (secret?.value) out.push(secret.value);
      } catch {
        // Sealed under another key: it cannot be matched, and nothing reads it.
      }
    }
    return out;
  }

  /** One secret's value, read and opened now; for the gateway only. */
  async open(level: StoredLevel, scope: string, name: string): Promise<ResolvedSecret | undefined> {
    const row = this.#row(level, scope, name);
    if (!row) return undefined;
    const [, iv, sealed] = row.sealed.split(".");
    let value: string;
    try {
      value = dec.decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: unb64(String(iv)), additionalData: aad(level, scope, name) },
          await this.#keyOrFail(),
          unb64(String(sealed)),
        ),
      );
    } catch (e) {
      if ((e as { code?: string }).code === "ENOSYS") throw e;
      throw codedError("EIO", `secret ${name} cannot be opened with this deployment's SECRETS_KEY`);
    }
    return { name, level: row.level as SecretLevel, value, bindings: JSON.parse(row.bindings) };
  }
}

const infoOf = (row: SecretRow): SecretInfo => ({
  name: row.name,
  level: row.level as SecretLevel,
  scope: row.scope,
  bindings: JSON.parse(row.bindings),
  updated: Number(row.updated),
});

// ---- deployment secrets -------------------------------------------------------------------------

/**
 * The deployment's secrets: the runtime variables its `DEPLOYMENT_SECRETS` declaration names
 * (`{"NAME": {"plugins": [...], "hosts": [...]}}`), with their bindings. A declared name with no
 * value is listed but not set. Undeclared variables are never secrets.
 */
export function deploymentSecrets(
  declaration: string | undefined,
  runtime: Record<string, unknown>,
): { info: SecretInfo[]; open(name: string): ResolvedSecret | undefined } {
  let declared: Record<string, unknown> = {};
  if (declaration?.trim()) {
    try {
      declared = JSON.parse(declaration);
    } catch {
      throw codedError("EIO", "DEPLOYMENT_SECRETS is not JSON");
    }
  }
  const secrets = new Map<string, SecretBinding>();
  for (const [name, binding] of Object.entries(declared ?? {})) {
    if (NEVER_SECRETS.has(name)) throw codedError("EIO", `${name} cannot be a deployment secret`);
    secrets.set(checkSecretName(name), checkBinding(binding));
  }
  return {
    info: [...secrets].map(([name, bindings]) => ({
      name,
      level: "deployment",
      scope: "",
      bindings,
      updated: 0,
    })),
    open(name) {
      const bindings = secrets.get(name);
      const value = runtime[name];
      if (!bindings || typeof value !== "string" || !value) return undefined;
      return { name, level: "deployment", value, bindings };
    },
  };
}

// ---- resolution and injection -------------------------------------------------------------------

/** Finds a secret by name for one agent session: the most specific level that has it. */
export type SecretLookup = (name: string) => Promise<ResolvedSecret | undefined>;

/** The lookup for an agent session: its user's, its project's, the workspace's, the deployment's. */
export function sessionSecrets(
  store: SecretStore,
  deployment: { open(name: string): ResolvedSecret | undefined },
  session: { project: string; user: string },
): SecretLookup {
  return async (name) =>
    (await store.open("user", session.user, name)) ??
    (await store.open("project", session.project, name)) ??
    (await store.open("workspace", "", name)) ??
    deployment.open(name);
}

/** A request a plugin sends out, before its secrets are put in. */
export interface OutgoingRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  /** Sent as is: placeholders in a body are refused, never resolved. */
  body?: string;
}

const PLACEHOLDER = /\{\{secret:([^{}]*)\}\}/g;
const ENCODED_PLACEHOLDER = /%7B%7Bsecret(?::|%3A)/i;

/** The secret names a text's placeholders name, in order of first use. */
const namesIn = (text: string): string[] =>
  [...text.matchAll(PLACEHOLDER)].map((m) => String(m[1]));

/** The outcome of resolving a request's placeholders: the request ready to send, or why not. */
export type Resolution =
  | {
      ok: true;
      url: string;
      headers: Record<string, string>;
      used: ResolvedSecret[];
      names: string[];
    }
  | { ok: false; error: string; names: string[] };

/**
 * Puts the secrets a request's placeholders name into its headers and URL, for one plugin. Each
 * name must be set at some level, and its winning secret's binding must name the plugin and the
 * request's host; otherwise nothing is resolved and the request must not be sent. Values are read
 * now, on each call.
 */
export async function resolveSecrets(
  request: OutgoingRequest,
  plugin: string,
  lookup: SecretLookup,
): Promise<Resolution> {
  const headers = { ...(request.headers ?? {}) };
  const texts = [request.url, ...Object.keys(headers), ...Object.values(headers)];
  const names = [...new Set(texts.flatMap(namesIn))];
  const fail = (error: string): Resolution => ({ ok: false, error, names });
  if (
    request.body !== undefined &&
    (namesIn(request.body).length > 0 || ENCODED_PLACEHOLDER.test(request.body))
  )
    return fail("EINVAL: secrets go only in a request's headers or URL, never its body");
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return fail("EINVAL: the request's URL is not absolute");
  }
  if (names.length === 0) return { ok: true, url: request.url, headers, used: [], names };
  if (Object.keys(headers).some((k) => namesIn(k).length > 0))
    return fail("EINVAL: a header's name cannot be a secret");
  // The host is the one the request goes to; a placeholder in the host is refused, so a secret's
  // value can never choose its own destination (userinfo may hold one: a URL credential).
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(request.url)?.[1] ?? "";
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  if (/\{|\}/.test(hostPart) || ENCODED_PLACEHOLDER.test(hostPart))
    return fail("EINVAL: a request's host cannot be a secret");
  const host = url.hostname.toLowerCase();
  const used: ResolvedSecret[] = [];
  for (const name of names) {
    if (!SECRET_NAME.test(name)) return fail(`EINVAL: '${name}' is not a secret's name`);
    const secret = await lookup(name);
    if (!secret) return fail(`ENOENT: secret ${name} is not set`);
    if (!secret.bindings.plugins.includes(plugin) || !secret.bindings.hosts.includes(host))
      return fail(`EACCES: secret ${name} is not bound to plugin '${plugin}' and host '${host}'`);
    used.push(secret);
  }
  const fill = (text: string) =>
    text.replace(PLACEHOLDER, (_, n: string) => used.find((s) => s.name === n)?.value ?? "");
  // In the URL, values are encoded for the part they land in (userinfo, path or query).
  const fillUrl = (text: string) =>
    text.replace(PLACEHOLDER, (_, n: string) =>
      encodeURIComponent(used.find((s) => s.name === n)?.value ?? ""),
    );
  for (const [k, v] of Object.entries(headers)) headers[k] = fill(v);
  const filled = fillUrl(request.url);
  if (new URL(filled).hostname.toLowerCase() !== host)
    return fail("EINVAL: a secret cannot change a request's host");
  return { ok: true, url: filled, headers, used, names };
}

/** Replaces every form of the used secrets' values in a text with `[secret NAME]`. */
export function redactSecrets(text: string, used: readonly ResolvedSecret[]): string {
  let out = text;
  // Longest first, so a value containing another is replaced whole.
  for (const s of [...used].sort((a, b) => b.value.length - a.value.length)) {
    const forms = new Set([
      s.value,
      encodeURIComponent(s.value),
      JSON.stringify(s.value).slice(1, -1),
    ]);
    try {
      forms.add(btoa(s.value));
    } catch {
      // not Latin-1: no base64 form to look for
    }
    for (const form of forms) if (form) out = out.split(form).join(`[secret ${s.name}]`);
  }
  return out;
}

/** What a call through the gateway answers: the response, redacted, or why it was not sent. */
export interface GatewayResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  body?: string;
  error?: string;
  /** The secret names the request used, never their values. */
  secrets: string[];
}

const MAX_BODY = 1024 * 1024;

/**
 * The host-side gateway for one plugin's outgoing request: resolves its secrets (bound plugin and
 * host only), sends it, and answers with the response's status and text, every value used
 * redacted from it and from any error. Redirects are not followed, so a secret never goes on to
 * another host.
 */
export async function gatewayFetch(
  request: OutgoingRequest,
  plugin: string,
  lookup: SecretLookup,
  fetcher: typeof fetch = fetch,
  guard?: { config: EgressConfig; transport: EgressTransport },
): Promise<GatewayResult> {
  const resolved = await resolveSecrets(request, plugin, lookup);
  if (!resolved.ok) return { ok: false, error: resolved.error, secrets: resolved.names };
  try {
    const init = {
      method: request.method ?? "GET",
      headers: resolved.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
    };
    let res: Response;
    if (guard) {
      // The egress gateway's address rule (statewalker/statewalker-root#208): https on the default
      // port, the name resolved by the gateway and every address admitted before connecting.
      const url = new URL(resolved.url);
      checkEgressUrl(url, guard.config);
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      const listed = guard.config.internalHosts.includes(host);
      const fixed = guard.config.hosts[host];
      const admit = (address: string) => {
        if (!listed && internalAddress(address))
          throw codedError("EACCES", `${host} resolves to an internal address (${address})`);
      };
      if (fixed) for (const a of fixed) admit(a);
      res = await guard.transport.fetch(
        url,
        {
          method: init.method.toUpperCase(),
          headers: init.headers,
          ...(request.body !== undefined ? { body: new TextEncoder().encode(request.body) } : {}),
        },
        admit,
      );
    } else res = await fetcher(resolved.url, { ...init, redirect: "manual" });
    let body = await res.text();
    if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type") ?? undefined,
      body: redactSecrets(body, resolved.used),
      secrets: resolved.names,
    };
  } catch (e) {
    const message = redactSecrets(String((e as Error)?.message ?? e), resolved.used);
    const coded = /^(EACCES|E2BIG|EINVAL): /.test(message);
    return {
      ok: false,
      error: coded ? message : `EIO: the request failed: ${message}`,
      secrets: resolved.names,
    };
  }
}
