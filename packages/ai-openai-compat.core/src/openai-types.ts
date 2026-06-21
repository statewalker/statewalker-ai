// Subset of OpenAI v1 wire types we accept and emit. We define them locally
// (rather than importing from `openai`) to keep this lib free of a runtime
// dep on the openai SDK and to scope to exactly what we support.

export interface OpenAITextPart {
  type: "text";
  text: string;
}
export interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}
export interface OpenAIFilePart {
  type: "file";
  file: { file_id?: string; file_data?: string; filename?: string };
}
export interface OpenAIInputAudioPart {
  type: "input_audio";
  input_audio: { data: string; format: "mp3" | "wav" };
}
export type OpenAIUserContentPart =
  | OpenAITextPart
  | OpenAIImagePart
  | OpenAIFilePart
  | OpenAIInputAudioPart;

export interface OpenAIUserMessage {
  role: "user";
  content: string | OpenAIUserContentPart[];
}
export interface OpenAISystemMessage {
  role: "system" | "developer";
  content: string | OpenAITextPart[];
}
export interface OpenAIAssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface OpenAIAssistantMessage {
  role: "assistant";
  content?: string | OpenAITextPart[] | null;
  tool_calls?: OpenAIAssistantToolCall[];
  refusal?: string | null;
}
export interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string | OpenAITextPart[];
}
export type OpenAIChatMessage =
  | OpenAIUserMessage
  | OpenAISystemMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage;

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  seed?: number;
  stream?: boolean;
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
  n?: number;
}

export interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      refusal: string | null;
      tool_calls?: OpenAIAssistantToolCall[];
    };
    finish_reason: string | null;
    logprobs: null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAICompletionRequest {
  model: string;
  prompt: string | string[];
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  stop?: string | string[];
  seed?: number;
  stream?: boolean;
  n?: number;
}

export interface OpenAICompletion {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    text: string;
    finish_reason: string | null;
    logprobs: null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAICompletionChunk {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    text: string;
    finish_reason: string | null;
    logprobs: null;
  }>;
}

export interface OpenAIEmbeddingsRequest {
  model: string;
  input: string | string[] | number[] | number[][];
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

export interface OpenAIEmbeddingsResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}
