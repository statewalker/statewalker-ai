/**
 * Tool execution engine — runs tool calls with parallel/sequential/batched strategies.
 *
 * Each tool execution is an AsyncGenerator that yields events as they happen
 * (including streaming onUpdate/onProgress from long-running tools).
 *
 * For parallel execution, `mergeBatch` interleaves events from concurrent
 * generators as they arrive — no buffering until all tools complete.
 */
import type { AgentEvent, AgentMessage } from "../events/agent-events.js";
import {
  agentToolCall,
  agentToolProgress,
  agentToolResult,
  agentToolUpdate,
  nowMs,
} from "../events/agent-events.js";
import type {
  AgentTool,
  ToolContext,
  ToolExecutionStrategy,
  ToolOutput,
} from "./agent-tool.js";
import { ToolError } from "./agent-tool.js";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolExecutionResult {
  toolResults: AgentMessage[];
  steeringMessages?: AgentMessage[];
}

type GetSteering = () => AgentMessage[];

// ---------------------------------------------------------------------------
// Generic merge utility
// ---------------------------------------------------------------------------

/**
 * Normalize any iterable/async-iterable into an AsyncGenerator.
 */
export async function* toAsyncGenerator<T, V, E>(
  iterator: AsyncIterable<T, V, E> | Iterable<T, V, E>,
): AsyncGenerator<T, V, E> {
  return yield* iterator;
}

/**
 * Run multiple async generators concurrently, yielding events as they
 * arrive from ANY generator. Collects and returns all return values.
 *
 * Invariant: each generator has exactly one in-flight `.next()` at a time.
 * Uses a fixed-size slots array so `Promise.race` tells us which settled,
 * and we re-arm only that one.
 */
export async function* mergeBatch<T, V, E>(
  iterators: (AsyncIterable<T, V, E> | Iterable<T, V, E>)[],
): AsyncGenerator<T, V[]> {
  const generators = iterators.map(toAsyncGenerator);
  const n = generators.length;
  if (n === 0) return [] as V[];

  const results = new Array<V>(n);
  let remaining = n;

  type Tagged = { idx: number; res: IteratorResult<T, V> };

  // One in-flight promise per generator, tagged with its index
  const slots: (Promise<Tagged> | null)[] = generators.map((gen, idx) =>
    gen.next().then((res) => ({ idx, res })),
  );

  while (remaining > 0) {
    const { idx, res } = await Promise.race(
      slots.filter((s): s is Promise<Tagged> => s !== null),
    );

    if (res.done) {
      results[idx] = res.value;
      slots[idx] = null;
      remaining--;
    } else {
      yield res.value;
      // Re-arm only the settled generator
      const gen = generators[idx];
      slots[idx] = gen ? gen.next().then((res) => ({ idx, res })) : null;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export async function* executeToolCalls(
  tools: AgentTool[],
  calls: ToolCall[],
  signal: AbortSignal,
  strategy: ToolExecutionStrategy,
  getSteering?: GetSteering,
): AsyncGenerator<AgentEvent, ToolExecutionResult> {
  switch (strategy.type) {
    case "sequential":
      return yield* executeSequential(tools, calls, signal, getSteering);
    case "parallel":
      return yield* executeBatch(tools, calls, signal, getSteering);
    case "batched":
      return yield* executeBatched(
        tools,
        calls,
        signal,
        strategy.size,
        getSteering,
      );
  }
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/**
 * Check for steering messages and skip remaining calls if interrupted.
 * Returns the steering messages if present (caller should break), or undefined.
 */
function* checkSteering(
  getSteering: GetSteering | undefined,
  remainingCalls: ToolCall[],
  results: AgentMessage[],
): Generator<AgentEvent, AgentMessage[] | undefined> {
  if (!getSteering) return undefined;
  const steering = getSteering();
  if (steering.length === 0) return undefined;

  // Skip all remaining calls
  for (const call of remainingCalls) {
    results.push(yield* skipToolCall(call));
  }
  return steering;
}

async function* executeSequential(
  tools: AgentTool[],
  calls: ToolCall[],
  signal: AbortSignal,
  getSteering?: GetSteering,
): AsyncGenerator<AgentEvent, ToolExecutionResult> {
  const results: AgentMessage[] = [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!call) continue;

    results.push(yield* executeSingleTool(tools, call, signal));

    const steeringMessages = yield* checkSteering(
      getSteering,
      calls.slice(i + 1),
      results,
    );
    if (steeringMessages) return { toolResults: results, steeringMessages };
  }

  return { toolResults: results };
}

async function* executeBatch(
  tools: AgentTool[],
  calls: ToolCall[],
  signal: AbortSignal,
  getSteering?: GetSteering,
): AsyncGenerator<AgentEvent, ToolExecutionResult> {
  const toolResults = yield* mergeBatch(
    calls.map((call) => executeSingleTool(tools, call, signal)),
  );

  const steeringMessages = yield* checkSteering(getSteering, [], toolResults);
  return { toolResults, steeringMessages };
}

async function* executeBatched(
  tools: AgentTool[],
  calls: ToolCall[],
  signal: AbortSignal,
  batchSize: number,
  getSteering?: GetSteering,
): AsyncGenerator<AgentEvent, ToolExecutionResult> {
  const results: AgentMessage[] = [];

  for (let i = 0; i < calls.length; i += batchSize) {
    const batch = calls.slice(i, i + batchSize);
    results.push(
      ...(yield* mergeBatch(
        batch.map((call) => executeSingleTool(tools, call, signal)),
      )),
    );

    const steeringMessages = yield* checkSteering(
      getSteering,
      calls.slice(i + batchSize),
      results,
    );
    if (steeringMessages) return { toolResults: results, steeringMessages };
  }

  return { toolResults: results };
}

// ---------------------------------------------------------------------------
// Single tool execution (AsyncGenerator with channel for streaming events)
// ---------------------------------------------------------------------------

async function* executeSingleTool(
  tools: AgentTool[],
  call: ToolCall,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, AgentMessage> {
  const tool = tools.find((t) => t.name === call.name);

  yield agentToolCall({
    toolCallId: call.id,
    toolName: call.name,
    args: call.args,
  });

  let output: ToolOutput;
  let isError = false;

  if (!tool) {
    output = { text: `Tool not found: ${call.name}`, isError: true };
    isError = true;
  } else {
    // Channel: callbacks push events, generator pulls them
    const pending: AgentEvent[] = [];
    let notify: (() => void) | null = null;
    let toolDone = false;

    const push = (event: AgentEvent) => {
      pending.push(event);
      notify?.();
    };

    const ctx: ToolContext = {
      toolCallId: call.id,
      toolName: call.name,
      signal,
      onUpdate: (partial) =>
        push(
          agentToolUpdate({
            toolCallId: call.id,
            toolName: call.name,
            text: partial.text,
            isError: partial.isError,
          }),
        ),
      onProgress: (text) =>
        push(
          agentToolProgress({
            toolCallId: call.id,
            toolName: call.name,
            text,
          }),
        ),
    };

    const resultPromise = tool
      .execute(call.args, ctx)
      .then((result) => {
        toolDone = true;
        notify?.();
        return result;
      })
      .catch((err) => {
        toolDone = true;
        notify?.();
        throw err;
      });

    // Yield streaming events as they arrive, until tool completes
    while (!toolDone || pending.length > 0) {
      if (pending.length > 0) {
        yield pending.shift() as AgentEvent;
      } else {
        await new Promise<void>((r) => {
          notify = r;
        });
      }
    }

    try {
      const result = await resultPromise;
      output = result;
    } catch (err) {
      isError = true;
      output = {
        text: err instanceof ToolError ? err.message : String(err),
        isError: true,
      };
    }
  }

  yield agentToolResult({
    toolCallId: call.id,
    toolName: call.name,
    text: output.text,
    isError,
    details: output.details,
  });

  return {
    role: "tool-result",
    content: output.text,
    timestamp: nowMs(),
    toolCallId: call.id,
    toolName: call.name,
    isError,
  } satisfies AgentMessage;
}

// ---------------------------------------------------------------------------
// Skip tool (sync generator — no awaits needed)
// ---------------------------------------------------------------------------

function* skipToolCall(call: ToolCall): Generator<AgentEvent, AgentMessage> {
  const text = "Skipped due to queued user message.";

  yield agentToolResult({
    toolCallId: call.id,
    toolName: call.name,
    text,
    isError: true,
  });

  return {
    role: "tool-result" as const,
    content: text,
    timestamp: nowMs(),
    toolCallId: call.id,
    toolName: call.name,
    isError: true,
  };
}
