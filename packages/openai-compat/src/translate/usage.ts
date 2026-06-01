import type { LanguageModelUsage } from "ai";

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

const orZero = (n: number | undefined): number => (n === undefined ? 0 : n);

export const toOpenAIUsage = (u: LanguageModelUsage | undefined): OpenAIUsage | undefined => {
  if (!u) return undefined;
  const prompt = orZero(u.inputTokens);
  const completion = orZero(u.outputTokens);
  const total = u.totalTokens === undefined ? prompt + completion : u.totalTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
};
