import { generateText, type LanguageModel } from "ai";
import type { Message } from "../state/message.js";
import { NodeType } from "../state/node-types.js";
import type { ToolCall } from "../state/tool-call.js";
import type { Turn } from "../state/turn.js";
import type { SummarySection, TurnGroup } from "../state/turn-group.js";
import {
  createDefaultElisionPolicy, elideToolResponse, type ToolElisionPolicy
} from "./tool-elision.js";

export interface SummaryOutput {
  content: string;
  sections?: SummarySection[];
}

export type SummarizerInput =
  | { kind: "depth-1"; turns: Turn[] }
  | { kind: "depth-k"; children: TurnGroup[]; depth: number };

export interface HierarchicalSummarizer {
  summarize(input: SummarizerInput): Promise<SummaryOutput>;
}

export interface HierarchicalSummarizerOptions {
  /** Single model for both depths, or per-depth routing. */
  model: LanguageModel | { depth1: LanguageModel; depthK: LanguageModel };
  /** Elision policy used when folding tool responses into depth-1 input. */
  elision?: ToolElisionPolicy;
  /** Leaf peeks (first user message) per child group when summarising depth-k. */
  spotPeekPerChild?: number;
  /** Cap on LLM output length; defaults to 800. */
  maxOutputTokens?: number;
}

const DEPTH1_SYSTEM_PROMPT = `You are summarising a range of agent conversation turns for long-term memory.
Produce two outputs:

1. A concise markdown summary ("content") — factual prose, short paragraphs, no fluff.
2. Optional structured sections ("sections") when the input is long or thematically varied:
   - Task / goal
   - Decisions made
   - Files / resources touched
   - Key results or conclusions
   - Open questions or next steps
   For each section, include "refs" — an array of turn ids from the input that this section draws from.

Respond with a single JSON object exactly matching this schema:
{
  "content": string,              // non-empty markdown
  "sections": [{ "title": string, "body": string, "refs": string[] }] | null
}

Do not include any prose outside of the JSON object.`;

const DEPTHK_SYSTEM_PROMPT = `You are summarising a range of already-summarised conversation groups for long-term memory.
Produce two outputs:

1. A concise markdown summary ("content") of what the child groups collectively accomplished.
2. Optional structured sections ("sections"); each section's "refs" SHALL be group ids seen in the input (tags starting with "G").

Respond with a single JSON object exactly matching this schema:
{
  "content": string,              // non-empty markdown
  "sections": [{ "title": string, "body": string, "refs": string[] }] | null
}

Do not include any prose outside of the JSON object.`;

export function createHierarchicalSummarizer(
  options: HierarchicalSummarizerOptions,
): HierarchicalSummarizer {
  const modelCfg = options.model;
  const hasPerDepth =
    modelCfg !== null &&
    typeof modelCfg === "object" &&
    "depth1" in modelCfg &&
    "depthK" in modelCfg;
  const depth1Model: LanguageModel = hasPerDepth
    ? (modelCfg as { depth1: LanguageModel }).depth1
    : (modelCfg as LanguageModel);
  const depthKModel: LanguageModel = hasPerDepth
    ? (modelCfg as { depthK: LanguageModel }).depthK
    : (modelCfg as LanguageModel);
  const elision = options.elision ?? createDefaultElisionPolicy();
  const spotPeekPerChild = options.spotPeekPerChild ?? 0;
  const maxOutputTokens = options.maxOutputTokens ?? 800;

  return {
    async summarize(input) {
      if (input.kind === "depth-1") {
        const rendered = renderDepth1Input(input.turns, elision);
        return runSummariser(depth1Model, DEPTH1_SYSTEM_PROMPT, rendered, maxOutputTokens);
      }
      const rendered = renderDepthKInput(input.children, spotPeekPerChild);
      return runSummariser(depthKModel, DEPTHK_SYSTEM_PROMPT, rendered, maxOutputTokens);
    },
  };
}

// ── Input rendering ─────────────────────────────────────────

export function renderDepth1Input(turns: Turn[], elision: ToolElisionPolicy): string {
  const parts: string[] = [];
  for (const turn of turns) {
    parts.push(`[T${turn.id}]`);
    for (const child of turn.children) {
      if (child.type === NodeType.userMessage) {
        parts.push(`User: ${(child as Message).text}`);
      } else if (child.type === NodeType.agentMessage) {
        const text = (child as Message).text;
        if (text) parts.push(`Assistant: ${text}`);
      } else if (child.type === NodeType.toolCall) {
        const tc = child as ToolCall;
        const args = JSON.stringify(tc.args ?? {});
        const raw = tc.result ?? "";
        const elided = elideToolResponse(raw, tc.toolName, tc.args, elision);
        parts.push(`Tool(${tc.toolName}) args=${args}`);
        if (elided) parts.push(`Tool-result: ${elided}`);
      }
    }
  }
  return parts.join("\n");
}

export function renderDepthKInput(children: TurnGroup[], spotPeekPerChild: number): string {
  const parts: string[] = [];
  for (const group of children) {
    parts.push(`[G${group.id}] depth=${group.depth}`);
    if (group.summaryText) parts.push(group.summaryText);
    const sections = group.sections;
    if (sections && sections.length > 0) {
      for (const s of sections) {
        parts.push(`## ${s.title}`);
        parts.push(s.body);
        if (s.refs.length > 0) parts.push(`refs: ${s.refs.join(", ")}`);
      }
    }
    if (spotPeekPerChild > 0) {
      const turns = group.descendantTurns();
      const peek = turns.slice(0, spotPeekPerChild);
      for (const turn of peek) {
        for (const child of turn.children) {
          if (child.type === NodeType.userMessage) {
            const text = (child as Message).text;
            if (text) parts.push(`peek[T${turn.id}]: User: ${text}`);
            break;
          }
        }
      }
    }
  }
  return parts.join("\n");
}

// ── LLM invocation + validation ─────────────────────────────

async function runSummariser(
  model: LanguageModel,
  system: string,
  prompt: string,
  maxOutputTokens: number,
): Promise<SummaryOutput> {
  const first = await generateText({
    model,
    system,
    prompt,
    maxOutputTokens,
  });
  const parsed = tryParseOutput(first.text);
  if (parsed && parsed.content.trim().length > 0) {
    return sanitise(parsed);
  }

  // Single retry with a fallback prompt explicitly demanding prose-only.
  const second = await generateText({
    model,
    system: `${system}\n\nIMPORTANT: Your previous response was empty or malformed. Return a valid JSON object with a non-empty "content" string.`,
    prompt,
    maxOutputTokens,
  });
  const parsed2 = tryParseOutput(second.text);
  if (parsed2 && parsed2.content.trim().length > 0) {
    return sanitise(parsed2);
  }
  throw new Error(
    "hierarchical-summariser: model returned empty or unparsable output after one retry",
  );
}

function tryParseOutput(raw: string): SummaryOutput | undefined {
  if (!raw) return undefined;
  // Allow the model to wrap JSON in a code fence or leading prose.
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(raw);
  const jsonText = fenced ? fenced[1] : extractJsonObject(raw);
  if (!jsonText) return undefined;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const obj = parsed as Record<string, unknown>;
    const content = typeof obj.content === "string" ? obj.content : "";
    const sections = Array.isArray(obj.sections) ? (obj.sections as unknown[]) : undefined;
    return { content, sections: sections as SummarySection[] | undefined };
  } catch {
    return undefined;
  }
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function sanitise(out: SummaryOutput): SummaryOutput {
  const sections = out.sections
    ?.map((s) => {
      if (!s || typeof s !== "object") return undefined;
      const obj = s as unknown as Record<string, unknown>;
      const title = typeof obj.title === "string" ? obj.title.trim() : "";
      const body = typeof obj.body === "string" ? obj.body.trim() : "";
      const refs = Array.isArray(obj.refs)
        ? (obj.refs as unknown[]).filter((r): r is string => typeof r === "string")
        : [];
      if (!title || !body || refs.length === 0) return undefined;
      return { title, body, refs } satisfies SummarySection;
    })
    .filter((s): s is SummarySection => s !== undefined);

  const result: SummaryOutput = { content: out.content.trim() };
  if (sections && sections.length > 0) {
    result.sections = sections;
  }
  return result;
}
