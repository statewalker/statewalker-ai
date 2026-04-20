import { createMCPClient } from "@ai-sdk/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BaseClass } from "@statewalker/shared-baseclass";
import type { ToolSet } from "ai";

export interface McpServerConfig {
  url: string;
  type?: "http" | "sse";
  headers?: Record<string, string>;
}

type McpClientEntry = {
  name: string;
  config: McpServerConfig;
  client: Awaited<ReturnType<typeof createMCPClient>>;
};

export class McpClientManager extends BaseClass {
  private clients: McpClientEntry[] = [];
  private _tools: ToolSet = {};
  private _desiredConfigs: Record<string, McpServerConfig> = {};

  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  private bumpRevision(): void {
    this.#revision++;
  }

  /**
   * Update configs and connect to servers. User-initiated — bumps revision
   * synchronously to trigger save, then connects in the background.
   */
  connectAll(servers: Record<string, McpServerConfig>): void {
    this._desiredConfigs = { ...servers };
    this.bumpRevision();
    this.notify();
    this.doConnect(servers)
      .then(() => this.notify())
      .catch((err) => console.error("MCP connectAll error:", err));
  }

  /**
   * Load servers from saved settings. Does NOT bump revision (no save needed).
   */
  async loadServers(
    servers: Record<string, McpServerConfig>,
    signal?: AbortSignal,
  ): Promise<void> {
    this._desiredConfigs = { ...servers };
    await this.doConnect(servers, signal);
    this.notify();
  }

  private async doConnect(
    servers: Record<string, McpServerConfig>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.closeAll();

    for (const [name, config] of Object.entries(servers)) {
      if (signal?.aborted) break;
      try {
        const transport =
          config.type === "http"
            ? new StreamableHTTPClientTransport(new URL(config.url), {
                requestInit: config.headers
                  ? { headers: config.headers }
                  : undefined,
              })
            : {
                type: "sse" as const,
                url: config.url,
                headers: config.headers,
              };

        const client = await createMCPClient({
          transport,
          name,
          onUncaughtError: (err) => console.error(`MCP [${name}]:`, err),
        });
        if (signal?.aborted) {
          await client.close().catch(() => {});
          break;
        }
        const tools = await client.tools();
        Object.assign(this._tools, tools);
        this.clients.push({ name, config, client });
      } catch (err) {
        if (signal?.aborted) break;
        console.error(`MCP [${name}]: failed to connect:`, err);
      }
    }
  }

  get tools(): ToolSet {
    return this._tools;
  }

  get hasTools(): boolean {
    return Object.keys(this._tools).length > 0;
  }

  get serverCount(): number {
    return this.clients.length;
  }

  get serverConfigs(): Record<string, McpServerConfig> {
    return { ...this._desiredConfigs };
  }

  async closeAll(): Promise<void> {
    for (const { client } of this.clients) {
      try {
        await client.close();
      } catch {
        // ignore close errors
      }
    }
    this.clients = [];
    this._tools = {};
  }
}
