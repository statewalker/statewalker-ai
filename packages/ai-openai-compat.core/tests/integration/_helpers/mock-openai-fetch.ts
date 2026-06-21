/**
 * In-memory mock OpenAI server. Takes a map of canned responses keyed by
 * the requested model id and returns a fetch function compatible with
 * `@ai-sdk/openai`'s `fetch` option.
 *
 * The mock only implements the endpoints touched by tests in this file
 * (chat/completions non-streaming + streaming, embeddings).
 */

export interface CannedChatCompletion {
  id?: string;
  model?: string;
  content: string;
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter";
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface CannedStreamChunk {
  delta?: string;
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter";
}

export interface CannedEmbedding {
  embedding: number[];
  prompt_tokens?: number;
}

export interface MockOpenAIBackend {
  chat?: Record<string, CannedChatCompletion>;
  stream?: Record<string, CannedStreamChunk[]>;
  embed?: Record<string, CannedEmbedding[]>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const sse = (chunks: unknown[]): Response => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) {
        c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      c.enqueue(encoder.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

const formatChatCompletion = (
  modelId: string,
  c: CannedChatCompletion,
): Record<string, unknown> => ({
  id: c.id ?? `chatcmpl-${modelId}`,
  object: "chat.completion",
  created: 0,
  model: c.model ?? modelId,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: c.tool_calls ? null : c.content,
        tool_calls: c.tool_calls?.map((tc) => ({
          id: tc.id,
          type: "function",
          function: tc.function,
        })),
      },
      finish_reason: c.finish_reason ?? "stop",
    },
  ],
  usage: {
    prompt_tokens: c.prompt_tokens ?? 1,
    completion_tokens: c.completion_tokens ?? 1,
    total_tokens: (c.prompt_tokens ?? 1) + (c.completion_tokens ?? 1),
  },
});

const formatStreamChunk = (
  modelId: string,
  chunk: CannedStreamChunk,
  index: number,
): Record<string, unknown> => ({
  id: `chatcmpl-${modelId}`,
  object: "chat.completion.chunk",
  created: 0,
  model: modelId,
  choices: [
    {
      index: 0,
      delta:
        chunk.delta !== undefined
          ? index === 0
            ? { role: "assistant", content: chunk.delta }
            : { content: chunk.delta }
          : {},
      finish_reason: chunk.finish_reason ?? null,
    },
  ],
});

const formatEmbeddings = (modelId: string, embeds: CannedEmbedding[]): Record<string, unknown> => ({
  object: "list",
  data: embeds.map((e, i) => ({
    object: "embedding",
    embedding: e.embedding,
    index: i,
  })),
  model: modelId,
  usage: {
    prompt_tokens: embeds.reduce((s, e) => s + (e.prompt_tokens ?? 1), 0),
    total_tokens: embeds.reduce((s, e) => s + (e.prompt_tokens ?? 1), 0),
  },
});

export const createMockOpenAIFetch = (backend: MockOpenAIBackend) => {
  const fetchImpl = async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" || input instanceof URL ? new URL(input) : new URL(input.url);
    const bodyText =
      init?.body !== undefined && init.body !== null
        ? typeof init.body === "string"
          ? init.body
          : (init.body as { toString(): string }).toString()
        : "";
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    const modelId = String(body.model ?? "");

    if (url.pathname.endsWith("/chat/completions")) {
      if (body.stream) {
        const chunks = backend.stream?.[modelId] ?? [];
        return sse(chunks.map((c, i) => formatStreamChunk(modelId, c, i)));
      }
      const canned = backend.chat?.[modelId];
      if (!canned) return json({ error: "model not found" }, 404);
      return json(formatChatCompletion(modelId, canned));
    }
    if (url.pathname.endsWith("/embeddings")) {
      const embeds = backend.embed?.[modelId] ?? [];
      return json(formatEmbeddings(modelId, embeds));
    }
    return json({ error: "not implemented" }, 404);
  };
  return fetchImpl as unknown as typeof fetch;
};
