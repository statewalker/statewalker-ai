import type { LanguageModel } from "ai";
import { generateText } from "ai";

export type ContentSummarizer = {
  summarize(text: string, maxTokens?: number): Promise<string>;
};

export function createContentSummarizer(options: {
  model: LanguageModel;
}): ContentSummarizer {
  return {
    async summarize(text, maxTokens) {
      const { text: summary } = await generateText({
        model: options.model,
        system: `Summarize the following text concisely while preserving key information. The summary should be suitable for generating embeddings for semantic search.`,
        prompt: text,
        maxOutputTokens: maxTokens ?? 500,
      });
      return summary;
    },
  };
}
