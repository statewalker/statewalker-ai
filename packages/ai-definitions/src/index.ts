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
  type CatalogTool,
  catalogAgents,
  catalogPlugins,
  catalogSkills,
  catalogTools,
  OPERATION_ID,
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
export { type DefinitionsViewOptions, definitionsView } from "./view.js";
