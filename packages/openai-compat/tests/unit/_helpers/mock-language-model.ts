import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

export type MockFinishReason = LanguageModelV3FinishReason["unified"];

export interface MockLanguageModelInit {
  modelId?: string;
  provider?: string;
  content?: LanguageModelV3Content[];
  finishReason?: MockFinishReason;
  usage?: Partial<LanguageModelV3Usage>;
  streamParts?: LanguageModelV3StreamPart[];
  onCall?: (options: LanguageModelV3CallOptions) => void;
  throwOnGenerate?: Error;
  throwOnStream?: Error;
}

const finishReasonObject = (unified: MockFinishReason): LanguageModelV3FinishReason => ({
  unified,
  raw: undefined,
});

const defaultUsage = (input = 1, output = 1): LanguageModelV3Usage => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: output,
    text: output,
    reasoning: undefined,
  },
});

export interface RecordingMockLanguageModel extends LanguageModelV3 {
  recordedCalls: LanguageModelV3CallOptions[];
}

export const mockLanguageModel = (init: MockLanguageModelInit = {}): RecordingMockLanguageModel => {
  const recordedCalls: LanguageModelV3CallOptions[] = [];
  const usage = { ...defaultUsage(), ...init.usage };
  const content: LanguageModelV3Content[] = init.content ?? [{ type: "text", text: "" }];
  const finishUnified: MockFinishReason = init.finishReason ?? "stop";

  return {
    specificationVersion: "v3",
    provider: init.provider ?? "mock",
    modelId: init.modelId ?? "mock-model",
    // Claim support for every URL so AI SDK won't attempt to download
    // multimodal URL parts during test runs.
    supportedUrls: { "*/*": [/.+/] },
    recordedCalls,
    async doGenerate(options) {
      recordedCalls.push(options);
      init.onCall?.(options);
      if (init.throwOnGenerate) throw init.throwOnGenerate;
      return {
        content,
        finishReason: finishReasonObject(finishUnified),
        usage,
        warnings: [],
        response: {
          id: "mock-response-id",
          modelId: init.modelId ?? "mock-model",
          timestamp: new Date(0),
        },
      };
    },
    async doStream(options) {
      recordedCalls.push(options);
      init.onCall?.(options);
      if (init.throwOnStream) throw init.throwOnStream;
      const parts: LanguageModelV3StreamPart[] = init.streamParts ?? [
        { type: "stream-start", warnings: [] },
        {
          type: "finish",
          finishReason: finishReasonObject(finishUnified),
          usage,
        },
      ];
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      });
      return { stream };
    },
  };
};
