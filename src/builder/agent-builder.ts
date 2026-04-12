import type { ProviderV3 } from "@ai-sdk/provider";
import type { ModelManager } from "@statewalker/ai-provider";
import { UnifiedProvider } from "@statewalker/ai-provider";
import type { FilesApi } from "@statewalker/webrun-files";
import { CompositeFilesApi } from "@statewalker/webrun-files-composite";
import type { ToolSet } from "ai";
import { ConfigManager } from "../config/config-manager.js";
import { SecretsManager } from "../config/secrets-manager.js";
import type { AgentContext } from "../config/types.js";
import type { SelectionStrategy } from "../context/select-messages.js";
import {
  AgentController,
  type AgentControllerConfig,
} from "../controller/agent-controller.js";
import { bridgeMcpTools } from "../mcp/bridge-mcp-tools.js";
import { McpClientManager } from "../mcp/mcp-client-manager.js";
import { FilesSessionManager } from "../sessions/files-session-manager.js";
import type { SessionManager } from "../sessions/types.js";
import { parseSkillMarkdown } from "../skills/skill-parser.js";
import type { SkillInfo } from "../skills/skill-types.js";
import { Agent } from "./agent.js";
import { SubAgentTool } from "./sub-agent-tool.js";

export type ToolFactory = (ctx: AgentContext) => ToolSet | Promise<ToolSet>;

interface McpServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "http" | "sse" | "stdio";
}

export class AgentBuilder {
  private _provider?: ProviderV3;
  private _model = "";
  private _filesApi?: FilesApi;
  private _systemFolder = "/.settings";
  private _excludedPaths: string[] = [];
  private _toolFactories: ToolFactory[] = [];
  private _staticTools: ToolSet[] = [];
  private _skills: SkillInfo[] = [];
  private _skillsFolder?: string;
  private _mcpServers?: Record<string, McpServerConfig>;
  private _mcpConfigFile?: string;
  private _subAgents: Array<{
    name: string;
    factory: (parent: AgentContext) => AgentBuilder;
  }> = [];
  private _sessionManager?: SessionManager;
  private _systemPrompt?: string;
  private _maxSteps?: number;
  private _selectionStrategy?: SelectionStrategy;
  private _modelManager?: ModelManager;

  // --- Provider ---

  /** Provide a pre-built ProviderV3 directly. */
  withProvider(provider: ProviderV3): this {
    this._provider = provider;
    return this;
  }

  withModel(model: string): this {
    this._model = model;
    return this;
  }

  /** Use a ModelManager for model resolution (recommended). */
  withModelManager(manager: ModelManager): this {
    this._modelManager = manager;
    return this;
  }

  // --- Files ---

  withFilesApi(files: FilesApi): this {
    this._filesApi = files;
    return this;
  }

  withSystemFolder(path: string): this {
    this._systemFolder = path.startsWith("/") ? path : `/${path}`;
    return this;
  }

  withExcludedPaths(...paths: string[]): this {
    this._excludedPaths.push(
      ...paths.map((p) => (p.startsWith("/") ? p : `/${p}`)),
    );
    return this;
  }

  // --- Tools ---

  withTools(toolsOrFactory: ToolSet | ToolFactory): this {
    if (typeof toolsOrFactory === "function") {
      this._toolFactories.push(toolsOrFactory);
    } else {
      this._staticTools.push(toolsOrFactory);
    }
    return this;
  }

  // --- Skills ---

  withSkills(skills: SkillInfo[]): this {
    this._skills.push(...skills);
    return this;
  }

  withSkillsFolder(path: string): this {
    this._skillsFolder = path.startsWith("/") ? path : `/${path}`;
    return this;
  }

  // --- MCP ---

  withMcpServers(config: Record<string, McpServerConfig>): this {
    this._mcpServers = config;
    return this;
  }

  withMcpConfigFile(path: string): this {
    this._mcpConfigFile = path;
    return this;
  }

  // --- Sub-agents ---

  withSubAgent(
    name: string,
    factory: (parent: AgentContext) => AgentBuilder,
  ): this {
    this._subAgents.push({ name, factory });
    return this;
  }

  // --- Session ---

  withSessionManager(manager: SessionManager): this {
    this._sessionManager = manager;
    return this;
  }

  // --- Prompt & behavior ---

  withSystemPrompt(prompt: string): this {
    this._systemPrompt = prompt;
    return this;
  }

  withMaxSteps(n: number): this {
    this._maxSteps = n;
    return this;
  }

  withSelectionStrategy(strategy: SelectionStrategy): this {
    this._selectionStrategy = strategy;
    return this;
  }

  // --- Build ---

  async build(): Promise<Agent> {
    // 1. Resolve provider
    const provider = this._provider ?? this.resolveProvider();

    // 2. Split filesApi into system + working
    const { systemFiles, workingFiles } = this.splitFilesApi();

    // 3. Config + Secrets (scoped to system folder)
    const config = new ConfigManager(systemFiles, this._systemFolder);
    const secrets = new SecretsManager(config);

    // 4. SessionManager
    const sessions =
      this._sessionManager ??
      new FilesSessionManager(systemFiles, this._systemFolder);

    // 5. AgentContext
    const context: AgentContext = {
      files: workingFiles,
      systemFiles,
      config,
      secrets,
      sessions,
      provider,
      model: this._model,
      modelManager: this._modelManager,
    };

    // 6. Resolve tools
    const controllerConfig: AgentControllerConfig = {
      provider,
      model: this._model,
      systemPrompt: this._systemPrompt,
      maxSteps: this._maxSteps,
      select: this._selectionStrategy,
    };
    const controller = new AgentController(controllerConfig);

    // Register static tools
    for (const toolSet of this._staticTools) {
      for (const [name, tool] of Object.entries(toolSet)) {
        controller.tools.register(name, tool);
      }
    }

    // Resolve tool factories
    for (const factory of this._toolFactories) {
      const toolSet = await factory(context);
      for (const [name, tool] of Object.entries(toolSet)) {
        controller.tools.register(name, tool);
      }
    }

    // 7. Skills
    for (const skill of this._skills) {
      controller.skills.register(skill);
    }
    if (this._skillsFolder) {
      await this.loadSkillsFolder(systemFiles, this._skillsFolder, controller);
    }

    // 8. MCP
    if (this._mcpServers || this._mcpConfigFile) {
      await this.connectMcp(config, controller);
    }

    // 9. Sub-agents
    for (const { name, factory } of this._subAgents) {
      const subAgentTool = new SubAgentTool(name, factory, context);
      controller.tools.register(name, subAgentTool.asTool());
    }

    return new Agent(controller, context);
  }

  // --- Private helpers ---

  private resolveProvider(): ProviderV3 {
    if (this._modelManager) {
      return new UnifiedProvider(this._modelManager.store);
    }
    throw new Error(
      "Provider not configured. Use .withProvider(provider) or .withModelManager(manager)",
    );
  }

  private splitFilesApi(): { systemFiles: FilesApi; workingFiles: FilesApi } {
    if (!this._filesApi) {
      throw new Error("FilesApi not configured. Use .withFilesApi(files)");
    }

    const systemFiles = this._filesApi;

    const allExcluded = [...this._excludedPaths];
    if (!allExcluded.some((p) => p.startsWith(this._systemFolder))) {
      allExcluded.push(this._systemFolder);
    }

    const composite = new CompositeFilesApi(this._filesApi);
    for (const excluded of allExcluded) {
      const prefix = excluded.endsWith("/") ? excluded : `${excluded}/`;
      composite.guard(
        ["write", "remove", "move", "mkdir"],
        (p: string) =>
          !p.startsWith(prefix) && p !== excluded.replace(/\/$/, ""),
        `Access denied: ${excluded}`,
      );
    }

    return { systemFiles, workingFiles: composite };
  }

  private async loadSkillsFolder(
    files: FilesApi,
    folder: string,
    controller: AgentController,
  ): Promise<void> {
    if (!(await files.exists(folder))) return;
    for await (const entry of files.list(folder)) {
      if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of files.read(entry.path)) chunks.push(chunk);
        const text = new TextDecoder().decode(
          chunks.length === 1 ? chunks[0] : this.concatBytes(chunks),
        );
        const skill = parseSkillMarkdown(text, entry.path);
        if (skill) controller.skills.register(skill);
      } catch {
        // Skip unparseable skill files
      }
    }
  }

  private async connectMcp(
    config: ConfigManager,
    controller: AgentController,
  ): Promise<void> {
    const mcp = new McpClientManager();
    let servers = this._mcpServers ?? {};

    if (this._mcpConfigFile) {
      const loaded = await config.load<{
        mcpServers: Record<string, McpServerConfig>;
      }>(this._mcpConfigFile);
      if (loaded?.mcpServers) {
        servers = { ...servers, ...loaded.mcpServers };
      }
    }

    if (Object.keys(servers).length > 0) {
      await mcp.loadServers(servers as Record<string, { url: string }>);
      bridgeMcpTools(mcp, controller.tools);
    }
  }

  private concatBytes(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((a, b) => a + b.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
