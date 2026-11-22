// The model gateway (statewalker/statewalker-root#105, #134): the only way an agent session
// reaches a model. It runs on the host side of the secrets boundary: it picks the model for each
// request within the user's rights, injects the provider's key at the last moment (the secrets
// gateway's binding rules: plugin `model-gateway`, the provider's host), falls back to the agent's
// next model on overload, rate-limit and unavailable errors, and meters every request.

import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { codedError } from "@statewalker/ai-access";
import {
  type CatalogModel,
  type CatalogProvider,
  lookupModel,
  type ModelRight,
  mayUse,
  type PinnedModels,
  usableModel,
} from "./models.js";
import {
  type ResolvedSecret,
  redactSecrets,
  resolveSecrets,
  type SecretLookup,
} from "./secrets.js";

/** The plugin name provider secrets are bound to. */
export const MODEL_GATEWAY_PLUGIN = "model-gateway";

/** How a request to a model ended. The first three fall back to the agent's next model. */
export type ModelOutcome =
  | "ok"
  | "overloaded"
  | "rate_limited"
  | "unavailable"
  | "error"
  | "aborted";

const FALLBACK: readonly ModelOutcome[] = ["overloaded", "rate_limited", "unavailable"];

/** One request to a model, metered. */
export interface ModelUsage {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  /** In the model's price unit, when it has prices. */
  cost?: number;
  latency_ms: number;
  outcome: ModelOutcome;
  /** Charged to the workspace's budget: false for a user-level provider (the user's own key). */
  charged: boolean;
}

/** One attempt of a request: its usage, and what went wrong. */
export interface ModelAttempt {
  usage: ModelUsage;
  error?: string;
}

/** The pi-ai message an answer is (kept loose: it travels between Durable Objects). */
export interface ModelMessage {
  role: "assistant";
  content: unknown[];
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: Record<string, number>;
  };
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
  [key: string]: unknown;
}

/** A model the turn ran on other than the one its message asked for, and why. */
export interface ModelSubstitution {
  requested: string;
  used: string;
  reason: string;
}

/** What an agent session asks the gateway: one model request. */
export interface ModelCall {
  /** pi-ai's normalized context (the transcript: system message, tools, history), as JSON. */
  context: { messages: unknown[] };
  /** The model the turn's message asked for (an id or an alias), instead of the session's. */
  model?: string;
  maxTokens?: number;
}

export interface ModelResponse {
  /** The final answer: the last attempt's message. */
  message: ModelMessage;
  /** The model the request was for (before any fallback). */
  model: string;
  /** Every attempt, in order: those before the last fell back. */
  attempts: ModelAttempt[];
  /** Set when the message asked for a model the request could not run on. */
  substitution?: ModelSubstitution;
}

/** Who a request is for, recorded with its usage. */
export interface ModelRequestMeta {
  session: string;
  turn?: string;
  user: string;
  project: string;
}

/**
 * Where usage goes. `admit` runs before every attempt: the seam where limits reserve spend and
 * refuse (statewalker/statewalker-root#179); `record` settles it.
 */
export interface ModelMeter {
  admit?(model: CatalogModel, meta: ModelRequestMeta): Promise<void> | void;
  record(usage: ModelUsage, meta: ModelRequestMeta): Promise<void> | void;
}

type StreamFn = (
  model: never,
  context: never,
  options: never,
) => { result(): Promise<ModelMessage> };

const STREAMS: Record<string, StreamFn> = {
  "openai-completions": openaiCompletions as unknown as StreamFn,
  "openai-responses": openaiResponses as unknown as StreamFn,
  "anthropic-messages": anthropicMessages as unknown as StreamFn,
};

/** Overload, rate-limit and unavailable errors, from a provider's status or message. */
export function classifyModelError(message: string | undefined): ModelOutcome {
  const text = String(message ?? "");
  if (/\b529\b|overload/i.test(text)) return "overloaded";
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) return "rate_limited";
  if (/\b(502|503|504)\b|unavailable|bad gateway|gateway time-?out/i.test(text))
    return "unavailable";
  return "error";
}

const empty = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** An answer that is only an error (the request never reached the model). */
export function errorMessage(model: CatalogModel | undefined, text: string): ModelMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: model?.provider ?? "gateway",
    model: model?.name ?? "none",
    usage: empty(),
    stopReason: "error",
    errorMessage: text,
    timestamp: Date.now(),
  };
}

function costOf(model: CatalogModel, u: ModelMessage["usage"]): number | undefined {
  const c = model.cost;
  if (!c) return undefined;
  return (
    (u.input * c.input +
      u.output * c.output +
      u.cacheRead * (c.cacheRead ?? 0) +
      u.cacheWrite * (c.cacheWrite ?? 0)) /
    1_000_000
  );
}

export interface ModelGatewayOptions {
  /** The secrets a session's requests may use (most specific level first). */
  secrets: SecretLookup;
  meter: ModelMeter;
  /** Test seam: the stream function for an API (pi-ai's otherwise). */
  streamOf?: (api: string) => StreamFn | undefined;
}

/** The secret levels each provider level may be served by. */
const SECRET_REACH: Record<CatalogProvider["level"], readonly string[]> = {
  user: ["user"],
  project: ["user", "project"],
  workspace: ["user", "project", "workspace"],
  deployment: ["user", "project", "workspace", "deployment"],
};

/** The key and headers of a provider, resolved through the secrets gateway's binding rules. */
export async function providerAccess(
  provider: CatalogProvider,
  secrets: SecretLookup,
): Promise<{ apiKey?: string; headers: Record<string, string>; used: ResolvedSecret[] }> {
  const KEY = "x-model-gateway-key";
  const headers: Record<string, string> = { ...(provider.headers ?? {}) };
  if (provider.secret) headers[KEY] = `{{secret:${provider.secret}}}`;
  // A provider is served only by secrets of its own level or a more specific one: a user's own
  // provider never borrows the workspace's or the deployment's key (nor a project's provider the
  // workspace's), whatever host the key is bound to.
  const reach = SECRET_REACH[provider.level];
  const own: SecretLookup = async (name) => {
    const found = await secrets(name);
    return found && reach.includes(found.level) ? found : undefined;
  };
  const resolved = await resolveSecrets(
    { url: provider.baseUrl, headers },
    MODEL_GATEWAY_PLUGIN,
    own,
  );
  if (!resolved.ok) throw new Error(resolved.error);
  const { [KEY]: apiKey, ...rest } = resolved.headers;
  return { ...(apiKey ? { apiKey } : {}), headers: rest, used: resolved.used };
}

/** The models a provider's `/models` endpoint lists (OpenAI and Anthropic shapes). */
export async function discoverModels(
  provider: CatalogProvider,
  secrets: SecretLookup,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  if (provider.api === "local") return [];
  const { apiKey, headers, used } = await providerAccess(provider, secrets);
  const auth: Record<string, string> =
    provider.api === "anthropic-messages"
      ? { ...(apiKey ? { "x-api-key": apiKey } : {}), "anthropic-version": "2023-06-01" }
      : apiKey
        ? { authorization: `Bearer ${apiKey}` }
        : {};
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetcher(url, { headers: { ...headers, ...auth }, redirect: "manual" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256);
  } catch (e) {
    throw new Error(redactSecrets(String((e as Error)?.message ?? e), used));
  }
}

export class ModelGateway {
  readonly #o: ModelGatewayOptions;

  constructor(options: ModelGatewayOptions) {
    this.#o = options;
  }

  /**
   * One request of a session: on the model the message asked for when the user may use it (else
   * the session's, with the substitution said), then, on overload, rate-limit or unavailable
   * errors only, the session's fallbacks in order. Rights are checked now, at every request.
   */
  async request(
    pinned: PinnedModels,
    call: ModelCall,
    right: ModelRight,
    meta: ModelRequestMeta,
  ): Promise<ModelResponse> {
    const { catalog } = pinned;
    let primary = pinned.model;
    let substitution: ModelSubstitution | undefined;
    if (call.model !== undefined) {
      const found = await usableModel(catalog, call.model, right);
      if ("model" in found) primary = found.model.id;
      else
        substitution = {
          requested: call.model,
          used: pinned.model,
          reason:
            found.why === "unconfigured"
              ? `no model '${call.model}' is configured for this session`
              : `you hold no right to the model '${call.model}'`,
        };
    }
    const chain: CatalogModel[] = [];
    for (const id of [primary, ...pinned.fallbacks]) {
      const model = lookupModel(catalog, id);
      if (model && !chain.includes(model) && (await mayUse(model, right))) chain.push(model);
    }
    if (substitution && chain[0]) substitution.used = chain[0].id;
    const first = chain[0];
    if (!first)
      return {
        message: errorMessage(
          lookupModel(catalog, primary),
          `EACCES: you hold no right to the session's model '${primary}' or its fallbacks`,
        ),
        model: primary,
        attempts: [],
        ...(substitution ? { substitution } : {}),
      };
    const attempts: ModelAttempt[] = [];
    let message: ModelMessage = errorMessage(first, "no attempt");
    for (const [i, model] of chain.entries()) {
      let attempt: { message: ModelMessage; attempt: ModelAttempt };
      try {
        attempt = await this.#attempt(catalog.providers[model.provider], model, call, meta);
      } catch (e) {
        // Refused before the model was asked (a key, a limit): nothing was sent or metered. The
        // first model's refusal is the request's; a fallback's is recorded with the attempts made.
        if (i === 0) throw e;
        const error = String((e as Error)?.message ?? e);
        attempts.push({
          usage: {
            model: model.id,
            provider: model.provider,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            latency_ms: 0,
            outcome: "error",
            charged: false,
          },
          error,
        });
        message = errorMessage(model, error);
        break;
      }
      attempts.push(attempt.attempt);
      message = attempt.message;
      if (!(FALLBACK.includes(attempt.attempt.usage.outcome) && i < chain.length - 1)) break;
    }
    return { message, model: first.id, attempts, ...(substitution ? { substitution } : {}) };
  }

  async #attempt(
    provider: CatalogProvider | undefined,
    model: CatalogModel,
    call: ModelCall,
    meta: ModelRequestMeta,
  ): Promise<{ message: ModelMessage; attempt: ModelAttempt }> {
    if (!provider) throw codedError("EIO", `model ${model.id} has no provider`);
    if (provider.api === "local")
      throw codedError("ENOSYS", "the local provider runs only in a browser");
    const stream = (this.#o.streamOf ?? ((api) => STREAMS[api]))(provider.api);
    if (!stream) throw codedError("ENOSYS", `the gateway does not speak ${provider.api}`);
    // Refusals before the model is asked (a key not bound to the gateway, a limit) fail the turn.
    const access = await providerAccess(provider, this.#o.secrets);
    await this.#o.meter.admit?.(model, meta);
    const piModel = {
      id: model.name,
      name: model.name,
      api: provider.api,
      provider: provider.id,
      baseUrl: provider.baseUrl,
      headers: access.headers,
      input: model.input ?? ["text"],
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cacheRead: model.cost?.cacheRead ?? 0,
        cacheWrite: model.cost?.cacheWrite ?? 0,
      },
      reasoning: false,
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? 4096,
    };
    const started = Date.now();
    let message: ModelMessage;
    try {
      message = await stream(
        piModel as never,
        call.context as never,
        {
          apiKey: access.apiKey ?? "none",
          maxRetries: 0,
          ...(call.maxTokens ? { maxTokens: call.maxTokens } : {}),
        } as never,
      ).result();
    } catch (e) {
      message = errorMessage(model, String((e as Error)?.message ?? e));
    }
    const latency = Date.now() - started;
    if (message.errorMessage)
      message = { ...message, errorMessage: redactSecrets(message.errorMessage, access.used) };
    const outcome: ModelOutcome =
      message.stopReason === "error"
        ? classifyModelError(message.errorMessage)
        : message.stopReason === "aborted"
          ? "aborted"
          : "ok";
    const u = message.usage ?? empty();
    const cost = costOf(model, u);
    const usage: ModelUsage = {
      model: model.id,
      provider: provider.id,
      input_tokens: u.input,
      output_tokens: u.output,
      cached_tokens: u.cacheRead,
      ...(cost !== undefined ? { cost } : {}),
      latency_ms: latency,
      outcome,
      charged: provider.level !== "user",
    };
    await this.#o.meter.record(usage, meta);
    return {
      message,
      attempt: {
        usage,
        ...(outcome !== "ok" && message.errorMessage ? { error: message.errorMessage } : {}),
      },
    };
  }
}
