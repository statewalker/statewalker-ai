import type { FilesApi } from "@statewalker/webrun-files";

/**
 * Dependency-injection bag handed to `ToolFactory` callers by
 * `AgentRuntime.build()`. Intentionally narrow: factories that need more
 * (provider, model, custom storage) accept those as closure-captured
 * constructor arguments at their own factory boundary.
 */
export interface AgentContext {
  /** The post-filter `FilesApi` exposed to tools. */
  files: FilesApi;
}
