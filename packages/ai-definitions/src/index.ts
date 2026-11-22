// Definitions (statewalker/statewalker-root#82, #128): the plugin loader, the catalog, the per-role
// definitions mount (`<project>/.agents/`), and agent definitions.

export {
  type AgentDefinition,
  type Allow,
  findAgent,
  matches,
  type NarrowedAgent,
  narrowAgent,
  parseAgent,
} from "./agents.js";
export {
  acceptBundle,
  BUILD_DIR,
  BUILD_MANIFEST,
  type BuildManifest,
  buildPlugin,
  type PluginBuilder,
  sha256,
  type ToolBuild,
  type ToolDescription,
} from "./builder.js";
export {
  type CatalogTool,
  catalogAgents,
  catalogPlugins,
  catalogSkills,
  catalogTools,
} from "./catalog.js";
export { type FrontMatter, formatFrontMatter, parseFrontMatter } from "./front-matter.js";
export {
  AGENT_PLUGINS_SCHEMA,
  EXTENSION,
  hashFiles,
  isItemName,
  isPluginName,
  loadPlugins,
  MAX_FILE_BYTES,
  MAX_PLUGIN_BYTES,
  MAX_PLUGIN_FILES,
  MCP_SCHEMA,
  type Plugin,
  readPlugin,
  readPlugins,
  writePlugin,
} from "./loader.js";
export {
  catalogMcpServers,
  MCP_REVISION,
  type McpOutgoing,
  type McpRoute,
  type McpServer,
  mcpAnswer,
  mcpCallOutput,
  mcpRequest,
  mcpServersOf,
  mcpTools,
} from "./mcp.js";
export {
  catalogToolDefinitions,
  closedSchema,
  type JsonSchema,
  type NativeBuild,
  nativeTools,
  OPERATION_ID,
  operationIds,
  type RestAuth,
  type RestParam,
  restRequest,
  restTools,
  TOOL_EXTENSION,
  type ToolAction,
  type ToolDefinition,
  type ToolExtension,
  type ToolRoute,
  type ToolSource,
  toMcpTool,
  toolDefinition,
  toolExtension,
  toolInput,
  toolName,
  toolOutput,
} from "./tools.js";
export { type DefinitionsViewOptions, definitionsView } from "./view.js";
