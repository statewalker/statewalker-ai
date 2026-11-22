// The core of a remote agent session (statewalker/statewalker-root#109, #144): where a local
// session runs Flue, this runs each turn as one task of an external harness behind a UHP server.
// - The first task copies in the files the session's capability can read under the agent's
//   `inputs`; later tasks continue the remote session (`previous_response_id`).
// - Tasks run in the background: the response id and the `Idempotency-Key` are kept in the DO's
//   SQLite before anything is sent, so a retry or a restart neither loses nor duplicates the task;
//   the task is polled from the DO's alarm (`tick`) until it ends.
// - Its items are mirrored into the session marked `external`.
// - A question (`input_request`) ends the turn waiting on an approval (a question for free text);
//   the answer goes to the server as the next task, which the answer's turn follows.
// - Returned artifacts are written back through the capability as one change set, a `write` under
//   the mode: when the mode asks, the turn waits on one approval listing the files.
// - Cancelling the turn sends UHP cancel and drops any write-back not yet applied.
// Every call to the server goes through the port (the Workspace DO), which holds the token, decides
// starting the task (an open-world `run` action) and meters it.
import { type ApprovalRequest, approvalId, codedError } from "@statewalker/ai-access";
import { approvalOf } from "@statewalker/ai-environment";
import type {
  AgentSessionConfig,
  ApprovalAnswer,
  ItemInput,
  SqlLike,
  StoredAction,
  TurnRun,
} from "@statewalker/ai-sessions";
import type { FilesApi } from "@statewalker/webrun-files";
import { collectInputs, packInput } from "./inputs.js";
import { itemsOf } from "./items.js";
import {
  answerInput,
  artifactsOf,
  inputRequestOf,
  isTerminal,
  isUhpId,
  projectPathOf,
  type UhpInputRequest,
  type UhpResponse,
  uhpError,
} from "./protocol.js";

/** One call to the session's UHP server, as the Workspace DO takes it. */
export type UhpCall =
  | { op: "respond"; body: Record<string, unknown>; idempotencyKey: string }
  | { op: "get"; response: string }
  | { op: "cancel"; response: string }
  | { op: "download"; container: string; file: string };

/** The server's answer: its status and JSON body, or its bytes (`download`); status 0 if unsent. */
export interface UhpAnswer {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
  error?: string;
}

/** A change set: project paths and their new contents. */
export interface ChangeSetFile {
  path: string;
  content: Uint8Array;
}

export interface RemotePort {
  /** One call to the server, with the session's capability (the run decision may throw an ask). */
  call(call: UhpCall): Promise<UhpAnswer>;
  /** The session's own gated file view (reads for the inputs). */
  files: FilesApi;
  /**
   * Writes a change set through the capability, decided as one `write` under the mode: throws the
   * approval it waits on, or the refusal.
   */
  applyChangeSet(files: ChangeSetFile[]): Promise<{ written: string[] }>;
  /** Resolves at the DO's next alarm after `ms` (rejects when `signal` aborts). */
  tick(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RemoteOptions {
  pollMs: number;
  /** Bytes of files copied in at start. */
  inputMaxBytes: number;
  /** Bytes of a write-back. */
  writeBackMaxBytes: number;
  /** Transient failures (status 0, 429, 5xx) in a row before a call fails the turn. */
  retries?: number;
}

interface TaskRow {
  id: number;
  turn: string | null;
  idem: string;
  input: string | null;
  previous: string | null;
  response: string | null;
  status: string;
}

const enc = new TextEncoder();
const toBase64 = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const transient = (status: number) => status === 0 || status === 429 || status >= 500;

export class RemoteCore {
  readonly #sql: SqlLike;
  readonly #options: RemoteOptions;

  constructor(sql: SqlLike, options: RemoteOptions) {
    this.#sql = sql;
    this.#options = options;
    sql.exec(`CREATE TABLE IF NOT EXISTS uhp_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn TEXT, idem TEXT NOT NULL, input TEXT, previous TEXT, response TEXT,
      status TEXT NOT NULL, created INTEGER NOT NULL)`);
    sql.exec("CREATE TABLE IF NOT EXISTS uhp_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS uhp_seen (item TEXT PRIMARY KEY)");
    sql.exec(`CREATE TABLE IF NOT EXISTS uhp_writebacks (id TEXT PRIMARY KEY, files TEXT NOT NULL,
      created INTEGER NOT NULL)`);
  }

  #rows<T>(query: string, ...args: unknown[]): T[] {
    return this.#sql.exec(query, ...args).toArray() as unknown as T[];
  }

  #state(key: string): string | undefined {
    const row = this.#rows<{ value: string }>("SELECT value FROM uhp_state WHERE key = ?", key)[0];
    return row ? String(row.value) : undefined;
  }

  #setState(key: string, value: string) {
    this.#sql.exec("INSERT OR REPLACE INTO uhp_state VALUES (?, ?)", key, value);
  }

  #task(where: string, ...args: unknown[]): TaskRow | undefined {
    return this.#rows<TaskRow>(
      `SELECT * FROM uhp_tasks WHERE ${where} ORDER BY id LIMIT 1`,
      ...args,
    )[0];
  }

  /** Whether a turn a restart left running has a remote task still to follow. */
  resumable(turn: string): boolean {
    return !!this.#task("turn = ? AND status IN ('pending', 'running')", turn);
  }

  /** The tasks still running remotely: what a stop must cancel. */
  #running(): TaskRow[] {
    return this.#rows<TaskRow>(
      "SELECT * FROM uhp_tasks WHERE status = 'running' AND response IS NOT NULL",
    );
  }

  /** Sends UHP cancel to every running task and drops pending work (archive, revoke). */
  async stop(port: Pick<RemotePort, "call">): Promise<void> {
    for (const task of this.#running()) await this.#cancel(port, task);
    this.#sql.exec("UPDATE uhp_tasks SET status = 'dropped' WHERE status = 'pending'");
    this.#dropWriteBacks();
  }

  #dropWriteBacks() {
    this.#sql.exec("DELETE FROM uhp_writebacks");
  }

  async #cancel(port: Pick<RemotePort, "call">, task: TaskRow) {
    this.#sql.exec("UPDATE uhp_tasks SET status = 'cancelled' WHERE id = ?", task.id);
    if (!task.response) return;
    try {
      await port.call({ op: "cancel", response: task.response });
    } catch {
      // The capability may be revoked already: the workspace cancels on revocation itself.
    }
  }

  /** Runs one turn of the session: a new task, or (continuing) the task an answer started. */
  async run(port: RemotePort, run: TurnRun, emit: (item: ItemInput) => void): Promise<undefined> {
    const { config, turn, signal } = run;
    let task = this.#task("turn = ? AND status IN ('pending', 'running')", turn);
    if (!task && run.continues) {
      // An answer started the next task (or allowed starting this one): this turn follows it.
      task = this.#task("turn IS NULL AND status IN ('pending', 'running')");
      if (task) this.#sql.exec("UPDATE uhp_tasks SET turn = ? WHERE id = ?", turn, task.id);
      else {
        // Nothing left to follow: a write-back the user answered is applied (or refused) by now.
        this.#dropWriteBacks();
        // An answer the server refused fails the turn it continues.
        const failed = this.#state("answer_error");
        if (failed !== undefined) {
          this.#sql.exec("DELETE FROM uhp_state WHERE key = 'answer_error'");
          throw new Error(failed);
        }
        return undefined;
      }
    }
    if (!task) task = await this.#create(port, config, turn, run.content, emit);
    try {
      await this.#drive(port, config, task, run, emit);
    } catch (e) {
      // A turn that ends without its task (cancelled, or failed: a limit, a refusal) stops the
      // task too, so nothing keeps running remotely.
      const now = this.#task("id = ?", task.id) ?? task;
      if (signal.aborted || now.status === "running") await this.#cancel(port, now);
      this.#dropWriteBacks();
      throw e;
    }
    return undefined;
  }

  async #create(
    port: RemotePort,
    config: AgentSessionConfig,
    turn: string,
    text: string,
    emit: (item: ItemInput) => void,
  ): Promise<TaskRow> {
    const previous = this.#state("last_response");
    let input: unknown[];
    if (previous) input = packInput(text);
    else {
      const collected = await collectInputs(
        port.files,
        config.project,
        config.run?.inputs,
        this.#options.inputMaxBytes,
      );
      input = packInput(text, collected.files);
      emit({
        kind: "tool_result",
        name: "uhp_inputs",
        output:
          `copied ${collected.files.length} file(s) in: ${collected.files.map((f) => f.path).join(", ") || "none"}` +
          (collected.skipped.length
            ? `; left out over the size limit: ${collected.skipped.join(", ")}`
            : ""),
        isError: false,
      });
    }
    this.#sql.exec(
      "INSERT INTO uhp_tasks (turn, idem, input, previous, status, created) VALUES (?, ?, ?, ?, 'pending', ?)",
      turn,
      `swk-${crypto.randomUUID()}`,
      JSON.stringify(input),
      previous ?? null,
      Date.now(),
    );
    return this.#task("turn = ? AND status = 'pending'", turn) as TaskRow;
  }

  /** A call, retried while it fails transiently (the same Idempotency-Key for a respond). */
  async #call(
    port: RemotePort,
    call: UhpCall,
    what: string,
    signal?: AbortSignal,
    retries = this.#options.retries ?? 5,
  ) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const answer = await port.call(call);
      if (answer.status >= 200 && answer.status < 300) return answer;
      if (!transient(answer.status) || attempt >= retries) {
        if (answer.status === 0) throw codedError("EIO", answer.error ?? `${what} failed`);
        throw uhpError(answer.status, answer.json, what);
      }
      await port.tick(this.#options.pollMs * 2 ** Math.min(attempt, 4), signal);
    }
  }

  async #drive(
    port: RemotePort,
    config: AgentSessionConfig,
    task: TaskRow,
    run: TurnRun,
    emit: (item: ItemInput) => void,
  ): Promise<void> {
    const { signal } = run;
    let response: UhpResponse;
    if (!task.response) {
      let answer: UhpAnswer;
      try {
        answer = await this.#call(
          port,
          {
            op: "respond",
            idempotencyKey: task.idem,
            body: {
              input: JSON.parse(task.input ?? "[]"),
              ...(task.previous ? { previous_response_id: task.previous } : {}),
              background: true,
              store: true,
            },
          },
          "the task",
          signal,
        );
      } catch (e) {
        const request = approvalOf(e);
        if (!request) throw e;
        // Starting the remote task asks (an open-world run action): the turn waits on it, and the
        // answer's turn starts it.
        this.#sql.exec("UPDATE uhp_tasks SET turn = NULL WHERE id = ?", task.id);
        run.onApproval(request, { method: "remote", path: request.action.path });
        return;
      }
      response = answer.json as UhpResponse;
      if (!isUhpId(response?.id)) throw codedError("EIO", "the UHP server answered no response id");
      this.#sql.exec(
        "UPDATE uhp_tasks SET response = ?, input = NULL, status = 'running' WHERE id = ?",
        response.id,
        task.id,
      );
      task = { ...task, response: response.id, status: "running" };
    } else {
      response = (await this.#call(port, { op: "get", response: task.response }, "a poll", signal))
        .json as UhpResponse;
    }
    for (;;) {
      this.#mirror(response, emit);
      if (isTerminal(String(response.status))) break;
      await port.tick(this.#options.pollMs, signal);
      response = (
        await this.#call(port, { op: "get", response: task.response as string }, "a poll", signal)
      ).json as UhpResponse;
    }
    this.#sql.exec("UPDATE uhp_tasks SET status = 'done' WHERE id = ?", task.id);
    this.#setState("last_response", response.id);
    const status = String(response.status);
    if (status === "failed")
      throw codedError(
        "EIO",
        `the remote task failed: ${response.error?.message ?? "no reason given"}`,
      );
    if (status === "cancelled") throw new Error("EINTR: the remote task was cancelled");
    const question = inputRequestOf(response);
    if (question) return this.#ask(config, question, response, run);
    if (status === "completed") await this.#writeBack(port, config, response, run, emit);
  }

  /** Mirrors the output items not mirrored yet, by their ids. */
  #mirror(response: UhpResponse, emit: (item: ItemInput) => void) {
    for (const [i, item] of (response.output ?? []).entries()) {
      const key = `${response.id}/${typeof item.id === "string" ? item.id : `#${i}`}`;
      // An item still being written is mirrored once it is done.
      if (item.status === "in_progress") continue;
      if (this.#rows("SELECT 1 FROM uhp_seen WHERE item = ?", key).length) continue;
      this.#sql.exec("INSERT INTO uhp_seen VALUES (?)", key);
      for (const out of itemsOf(item)) emit(out);
    }
  }

  async #ask(
    config: AgentSessionConfig,
    question: UhpInputRequest,
    response: UhpResponse,
    run: TurnRun,
  ) {
    if (config.unattended)
      throw codedError(
        "EACCES",
        `the remote harness asked "${question.prompt}"; the session is unattended, so nobody can answer it`,
      );
    const remote = config.run?.remote;
    const request: ApprovalRequest = {
      id: await approvalId(config.id, "input", question.id),
      session: config.id,
      project: config.project,
      action: { method: "input", path: question.id },
      permission: `agents.use:remote:${remote?.server}/${remote?.harness}`,
      reason: question.prompt,
      input: {
        kind: question.kind,
        prompt: question.prompt,
        ...(question.options ? { options: question.options } : {}),
        ...(question.expires_at ? { expires: question.expires_at * 1000 } : {}),
      },
    };
    run.onApproval(request, { method: "input", path: question.id, target: response.id });
  }

  /**
   * The user's answer to a question: sent to the server now, as the task the answer's turn will
   * follow (a secret's value goes nowhere else). A denial voids the question.
   */
  async answer(
    port: RemotePort,
    approval: string,
    stored: StoredAction,
    request: ApprovalRequest,
    answer: ApprovalAnswer,
  ): Promise<void> {
    if (stored.method === "remote") {
      // Starting the task was denied: it never starts.
      if (answer.decision !== "allow")
        this.#sql.exec(
          "UPDATE uhp_tasks SET status = 'dropped' WHERE turn IS NULL AND status = 'pending'",
        );
      return;
    }
    if (stored.method !== "input" || !request.input || !stored.target) return;
    const input = answerInput({ id: stored.path, ...request.input } as UhpInputRequest, answer);
    const idem = `swk-${approval}`;
    this.#sql.exec(
      "UPDATE uhp_tasks SET status = 'dropped' WHERE turn IS NULL AND status = 'pending'",
    );
    let id: unknown;
    try {
      const sent = await this.#call(
        port,
        {
          op: "respond",
          idempotencyKey: idem,
          body: { input, previous_response_id: stored.target, background: true, store: true },
        },
        "the answer",
        undefined,
        1,
      );
      id = (sent.json as UhpResponse)?.id;
      if (!isUhpId(id)) throw codedError("EIO", "the UHP server answered no response id");
    } catch (e) {
      // Kept for the turn the answer continues, which fails with it (never the answer itself).
      this.#setState("answer_error", String((e as Error)?.message ?? e));
      throw e;
    }
    this.#sql.exec(
      "INSERT INTO uhp_tasks (turn, idem, previous, response, status, created) VALUES (NULL, ?, ?, ?, 'running', ?)",
      idem,
      stored.target,
      id,
      Date.now(),
    );
  }

  /** Downloads the response's artifacts and writes them back as one change set. */
  async #writeBack(
    port: RemotePort,
    config: AgentSessionConfig,
    response: UhpResponse,
    run: TurnRun,
    emit: (item: ItemInput) => void,
  ) {
    const artifacts = artifactsOf(response);
    if (!artifacts.length) return;
    const files: ChangeSetFile[] = [];
    const left: string[] = [];
    let total = 0;
    for (const a of artifacts) {
      const path = projectPathOf(config.project, a.filename);
      if (!path || !isUhpId(a.container) || !isUhpId(a.file)) {
        left.push(`${a.filename} (not a path in the project)`);
        continue;
      }
      const got = await this.#call(
        port,
        { op: "download", container: a.container, file: a.file },
        "a download",
        run.signal,
      );
      const bytes = got.bytes ?? new Uint8Array();
      if (total + bytes.length > this.#options.writeBackMaxBytes) {
        left.push(`${a.filename} (over the size limit)`);
        continue;
      }
      total += bytes.length;
      files.push({ path, content: bytes });
    }
    const note = left.length ? `; left out: ${left.join(", ")}` : "";
    if (!files.length) {
      emit({
        kind: "tool_result",
        name: "uhp_write_back",
        output: `nothing written${note}`,
        isError: true,
      });
      return;
    }
    const id = `wb-${crypto.randomUUID()}`;
    this.#sql.exec(
      "INSERT INTO uhp_writebacks VALUES (?, ?, ?)",
      id,
      JSON.stringify(files.map((f) => ({ path: f.path, content: toBase64(f.content) }))),
      Date.now(),
    );
    try {
      const done = await port.applyChangeSet(files);
      this.#sql.exec("DELETE FROM uhp_writebacks WHERE id = ?", id);
      emit({
        kind: "tool_result",
        name: "uhp_write_back",
        output: `wrote ${done.written.join(", ")}${note}`,
        isError: false,
      });
    } catch (e) {
      const request = approvalOf(e);
      if (request) {
        run.onApproval(request, {
          method: "changeset",
          path: `/${config.project}`,
          target: id,
          content: enc.encode(id),
        });
        return;
      }
      this.#sql.exec("DELETE FROM uhp_writebacks WHERE id = ?", id);
      emit({
        kind: "tool_result",
        name: "uhp_write_back",
        output: String((e as Error)?.message ?? e),
        isError: true,
      });
    }
  }

  /** Applies a write-back the user allowed (the gate consumes their grant), once. */
  async applyWriteBack(port: Pick<RemotePort, "applyChangeSet">, id: string) {
    const row = this.#rows<{ files: string }>(
      "SELECT files FROM uhp_writebacks WHERE id = ?",
      id,
    )[0];
    if (!row) throw codedError("ENOENT", "the write-back was dropped");
    const files = (JSON.parse(String(row.files)) as { path: string; content: string }[]).map(
      (f) => ({
        path: f.path,
        content: fromBase64(f.content),
      }),
    );
    try {
      return await port.applyChangeSet(files);
    } finally {
      this.#sql.exec("DELETE FROM uhp_writebacks WHERE id = ?", id);
    }
  }

  /** Drops everything this session keeps (purge). */
  purge() {
    this.#sql.exec(
      "DROP TABLE IF EXISTS uhp_tasks; DROP TABLE IF EXISTS uhp_state; DROP TABLE IF EXISTS uhp_seen; DROP TABLE IF EXISTS uhp_writebacks",
    );
  }
}
