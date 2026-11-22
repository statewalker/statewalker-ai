// The session API over RPC: webrun-rpc methods over msgpack frames on a WebSocket the
// deployment's Worker accepts at /v1/rpc. The access token goes in the first call.

import { openAiFetch } from "@statewalker/ai-openai-compat";
import {
  resumePlan,
  sessionChatTransport,
  sessionRpcClient,
  statusOf,
  uiMessageChunks,
} from "@statewalker/ai-sessions";
import { uhpFetch } from "@statewalker/ai-uhp";
import type { Deployment } from "./deployment.js";
import {
  ApiError,
  openAiBaseUrl,
  type SessionClient,
  TERMINAL_EVENTS,
  type Turn,
  UHP_BASE_URL,
} from "./session-client.js";

interface ClientSocket {
  accept(): void;
  close(code?: number, reason?: string): void;
}

export interface RpcSessionClient extends SessionClient {
  close(): void;
}

/** Opens a WebSocket to the deployment and runs the session API's RPC client over it. */
export async function rpcClient(deployment: Deployment, token: string): Promise<RpcSessionClient> {
  const res = await deployment.fetch("/v1/rpc", { headers: { upgrade: "websocket" } });
  const ws = (res as Response & { webSocket?: ClientSocket | null }).webSocket;
  if (res.status !== 101 || !ws) throw new ApiError(res.status, "the deployment refused RPC");
  ws.accept();
  const connection = await sessionRpcClient(ws as never, token);
  const api = connection.api;
  const refusal = (e: unknown) => {
    throw new ApiError(statusOf(e), String((e as Error)?.message ?? e));
  };
  const client: RpcSessionClient = {
    // The projection runs here, over the session API's RPC methods.
    openai: (project, agent) => ({
      baseURL: openAiBaseUrl(project, agent),
      apiKey: token,
      fetch: openAiFetch(api) as typeof fetch,
    }),
    uhp: () => ({ baseURL: UHP_BASE_URL, apiKey: token, fetch: uhpFetch(api) as typeof fetch }),
    chat: (id) => sessionChatTransport(api, id),
    async replayChat(id, from = {}) {
      const plan = await resumePlan(api, id, from).catch(refusal);
      return plan ? uiMessageChunks(api, id, plan) : null;
    },
    me: () => api.me().catch(refusal),
    startSession: (req) => api.startSession(req as never).catch(refusal),
    getSession: (id) => api.getSession(id).catch(refusal),
    updateSession: (id, req) => api.updateSession(id, req).catch(refusal),
    archiveSession: (id) => api.archiveSession(id).catch(refusal),
    deleteSession: (id) => api.deleteSession(id).catch(refusal),
    listSessions: (q) => api.listSessions(q).catch(refusal),
    postMessage: (id, req) => api.sendMessage(id, req).catch(refusal),
    sendMessage: async (id, req) => client.waitTurn(await client.postMessage(id, req)),
    async waitTurn(accepted) {
      // Cursor reads of the event log, each waiting for the next event.
      let since = accepted.offset;
      for (;;) {
        const page = await api
          .readEvents(accepted.session_id, { since, wait: 10_000 })
          .catch(refusal);
        for (const event of page.events)
          if (TERMINAL_EVENTS.includes(event.type) && event.turn === accepted.turn_id)
            return event.data as Turn;
        since = page.offset;
      }
    },
    getTurn: (id) => api.getTurn(id).catch(refusal) as never,
    rewind: (id, req) => api.rewind(id, req).catch(refusal),
    setHead: (id, req) => api.setHead(id, req).catch(refusal),
    editTurn: (id, req) => api.editTurn(id, req).catch(refusal),
    regenerateTurn: (id, req) => api.regenerateTurn(id, req).catch(refusal),
    listBranches: (id) => api.listBranches(id).catch(refusal),
    listTopics: (id, q) => api.listTopics(id, q).catch(refusal),
    eraseBranch: (id, turn) => api.eraseBranch(id, turn).catch(refusal),
    forkSession: (id, req) => api.forkSession(id, req).catch(refusal) as never,
    cancelTurn: (id) => api.cancelTurn(id).catch(refusal),
    listItems: (id, q) => api.listItems(id, q).catch(refusal),
    getItem: (id, itemId) => api.getItem(id, itemId).catch(refusal),
    readEvents: (id, q) => api.readEvents(id, q).catch(refusal),
    profile: () => api.profile().catch(refusal),
    eraseUser: () => api.eraseUser().catch(refusal),
    setMode: (req) => api.setMode(req).catch(refusal) as never,
    listApprovals: () => api.listApprovals().catch(refusal) as never,
    answerApproval: (id, answer) => api.answerApproval(id, answer).catch(refusal) as never,
    listSecrets: (scope) => api.listSecrets(scope).catch(refusal),
    setSecret: (req) => api.setSecret(req).catch(refusal),
    deleteSecret: (req) => api.deleteSecret(req).catch(refusal),
    revokeSession: (id) => api.revokeSession(id).catch(refusal),
    revokeUserSession: () => api.revokeUserSession().catch(refusal),
    listServiceAccounts: () => api.listServiceAccounts().catch(refusal),
    createServiceAccount: (req) => api.createServiceAccount(req).catch(refusal),
    deleteServiceAccount: (name) => api.deleteServiceAccount(name).catch(refusal),
    listModels: (q) => api.listModels(q).catch(refusal) as never,
    getModelConfig: () => api.getModelConfig().catch(refusal) as never,
    setModelConfig: (config) => api.setModelConfig(config as never).catch(refusal) as never,
    mcp: (id, message) => api.mcp(id, message as never).catch(refusal) as never,
    listMemory: (target) => api.listMemory(target).catch(refusal) as never,
    memoryEntry: (target, id) => api.memoryEntry(target, id).catch(refusal) as never,
    memoryFile: (target, name) => api.memoryFile(target, name).catch(refusal) as never,
    memoryBatch: (target, actions) =>
      api.memoryBatch(target, actions as never).catch(refusal) as never,
    eraseMemory: (target, which) => api.eraseMemory(target, which).catch(refusal) as never,
    listAgentMemories: (project) => api.listAgentMemories(project).catch(refusal) as never,
    exportProfile: async () => new Uint8Array(await api.exportProfile().catch(refusal)),
    eraseProfile: () => api.eraseProfile().catch(refusal) as never,
    effectiveLimits: (q) => api.effectiveLimits(q ?? {}).catch(refusal) as never,
    usage: (q) => api.usage((q ?? {}) as never).catch(refusal) as never,
    getLimits: (level, target) => api.getLimits(level, target).catch(refusal) as never,
    setLimits: (level, target, req) =>
      api.setLimits(level, target, req as never).catch(refusal) as never,
    deleteLimits: (level, target) => api.deleteLimits(level, target).catch(refusal) as never,
    // The task API (statewalker/statewalker-root#206).
    publish: (p, t) => api.publish(p, t).catch(refusal) as never,
    listTasks: (p, o) => api.listTasks(p, o).catch(refusal) as never,
    subscribe: (p, sub) => api.subscribe(p, sub).catch(refusal) as never,
    listSubscriptions: (p) => api.listSubscriptions(p).catch(refusal) as never,
    getSubscription: (p, n) => api.getSubscription(p, n).catch(refusal) as never,
    unsubscribe: (p, n) => api.unsubscribe(p, n).catch(refusal) as never,
    peek: (p, n, o) => api.peek(p, n, o).catch(refusal) as never,
    take: (p, n, o) => api.take(p, n, o).catch(refusal) as never,
    claim: (p, n, o) => api.claim(p, n, o).catch(refusal) as never,
    deadLetters: (p, n) => api.deadLetters(p, n).catch(refusal) as never,
    changes: (p, n, o) => api.changes(p, n, o).catch(refusal) as never,
    createInbox: (p) => api.createInbox(p).catch(refusal) as never,
    reply: (p, t, r) => api.reply(p, t, r).catch(refusal) as never,
    ack: (l) => api.ack(l).catch(refusal) as never,
    release: (l, o) => api.release(l, o).catch(refusal) as never,
    renew: (l, o) => api.renew(l, o).catch(refusal) as never,
    job: (p, id) => api.job(p, id).catch(refusal) as never,
    // The trigger API (statewalker/statewalker-root#207).
    listTriggers: (p) => api.listTriggers(p).catch(refusal) as never,
    createTrigger: (p, t) => api.createTrigger(p, t).catch(refusal) as never,
    getTrigger: (p, id) => api.getTrigger(p, id).catch(refusal) as never,
    updateTrigger: (p, id, patch) => api.updateTrigger(p, id, patch).catch(refusal) as never,
    deleteTrigger: (p, id) => api.deleteTrigger(p, id).catch(refusal) as never,
    triggerFires: (p, id, q) => api.triggerFires(p, id, q).catch(refusal) as never,
    fireTrigger: (id, req) => api.fireTrigger(id, req).catch(refusal) as never,
    listOwnTriggers: () => api.listOwnTriggers().catch(refusal) as never,
    async taskEvents(p, n, count, waitMs = 30_000) {
      const seqs: number[] = [];
      let seq = (await api.changes(p, n, { wait_ms: 0 }).catch(refusal)).seq;
      seqs.push(seq);
      while (seqs.length < count) {
        const next = (await api.changes(p, n, { after: seq, wait_ms: waitMs }).catch(refusal)).seq;
        if (next > seq) seqs.push(next);
        seq = next;
      }
      return seqs;
    },
    async usageRecords(q = {}) {
      // Page by page, after the last record's seq.
      const all: never[] = [];
      let after: number | undefined;
      for (;;) {
        const page = await api
          .usageRecords({ ...q, ...(after !== undefined ? { after } : {}) })
          .catch(refusal);
        all.push(...(page.records as never[]));
        if (page.next === undefined) return all;
        after = page.next;
      }
    },
    close: () => connection.close(),
  };
  return client;
}
