// The OpenAI projection of the session API (statewalker/statewalker-root#138): Responses,
// Conversations, Chat Completions and models per agent base URL
// (`/v1/projects/<project>/agents/<agent>/`), so existing OpenAI clients drive harness agents.
export { CHAT_METADATA, chatChunks, chatCompletion, type StartedChat, startChat } from "./chat.js";
export {
  approvalRequest,
  type CallInfo,
  type CallOfApproval,
  mapItems,
  type OpenAiItem,
  OutputMapper,
  SERVER_LABEL,
} from "./output.js";
export {
  type AgentRoute,
  type ApprovalAnswerInput,
  allItems,
  type CreatedResponse,
  conversationItems,
  conversationOf,
  createdResponse,
  createResponse,
  DEFAULT_AGENT,
  EventEncoder,
  inputOf,
  isTerminal,
  messageText,
  type OpenAiApi,
  responseEvents,
  responseOf,
  textOf,
} from "./responses.js";
export {
  handleOpenAiRest,
  type OpenAiOptions,
  openAiError,
  openAiFetch,
  sseResponse,
} from "./routes.js";
