import type { ProviderV3 } from "@ai-sdk/provider";
import type { FilesApi } from "@statewalker/webrun-files";
import type { FilesSessionManager } from "../sessions/files-session-manager.js";
import type { ConfigManager } from "./config-manager.js";
import type { SecretsManager } from "./secrets-manager.js";

export interface AgentContext {
  /** Working files (guarded, for tool access). */
  files: FilesApi;
  /** System files (configs, secrets, sessions). */
  systemFiles: FilesApi;
  /** JSON configuration loader. */
  config: ConfigManager;
  /** API key and credentials access. */
  secrets: SecretsManager;
  /** Session persistence. */
  sessions: FilesSessionManager;
  /** AI provider instance. */
  provider: ProviderV3;
  /** Model identifier. */
  model: string;
}
