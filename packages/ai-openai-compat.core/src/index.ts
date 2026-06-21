import type { EmbeddingModelV3, LanguageModelV3 } from "@ai-sdk/provider";
import { handleChatCompletions } from "./endpoints/chat-completions.js";
import { handleCompletions } from "./endpoints/completions.js";
import { handleEmbeddings } from "./endpoints/embeddings.js";
import { handleModels } from "./endpoints/models.js";
import { errorResponse } from "./errors.js";

export interface Init {
  languageModels?: Record<string, LanguageModelV3>;
  embeddingModels?: Record<string, EmbeddingModelV3>;
  /** Default `/v1`. Handler matches `${basePath}/<endpoint>`. */
  basePath?: string;
}

const notFound = (req: Request, pathname: string): Response =>
  errorResponse(
    404,
    "invalid_request_error",
    "invalid_request_error",
    `Unknown route: ${req.method} ${pathname}`,
  );

export const createOpenAICompat = (init: Init): ((req: Request) => Promise<Response>) => {
  const basePath = (init.basePath ?? "/v1").replace(/\/+$/, "");
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(`${basePath}/`)) {
      return notFound(req, url.pathname);
    }
    const sub = url.pathname.slice(basePath.length);
    if (sub === "/models" && req.method === "GET") {
      return handleModels(init);
    }
    if (sub === "/chat/completions" && req.method === "POST") {
      return handleChatCompletions(req, init);
    }
    if (sub === "/completions" && req.method === "POST") {
      return handleCompletions(req, init);
    }
    if (sub === "/embeddings" && req.method === "POST") {
      return handleEmbeddings(req, init);
    }
    return notFound(req, url.pathname);
  };
};
