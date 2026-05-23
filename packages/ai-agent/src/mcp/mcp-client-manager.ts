import { createMCPClient } from "@ai-sdk/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BaseClass } from "@statewalker/shared-baseclass";
import type { ToolSet } from "ai";

export interface McpServerConfig {
  url: string;
  type?: "http" | "sse";
  headers?: Record<string, string>;
}

/** Context for a routed error — typically the server it relates to. */
export interface McpErrorContext {
  server?: string;
}

export type McpErrorHandler = (error: Error, ctx?: McpErrorContext) => void;

const defaultErrorHandler: McpErrorHandler = (error, ctx) => {
  console.warn("[McpClientManager]", ctx?.server ?? "", error);
};

type McpClientEntry = {
  name: string;
  config: McpServerConfig;
  client: Awaited<ReturnType<typeof createMCPClient>>;
};

export class McpClientManager extends BaseClass {
  private clients: McpClientEntry[] = [];
  private _tools: ToolSet = {};
  private _desiredConfigs: Record<string, McpServerConfig> = {};
  private _errorHandler: McpErrorHandler = defaultErrorHandler;

  /**
   * Install an error handler. Defaults to `console.warn`. The handler is
   * invoked at every site that previously logged or silently swallowed an
   * error — connection failures, MCP client uncaught errors, close-time
   * errors. Existing throw/continue semantics are preserved (nothing throws
   * that did not throw before).
   */
  setErrorHandler(handler: McpErrorHandler): this {
    this._errorHandler = handler;
    return this;
  }

  /** Connect to the given servers. */
  async loadServers(servers: Record<string, McpServerConfig>, signal?: AbortSignal): Promise<void> {
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
                requestInit: config.headers ? { headers: config.headers } : undefined,
              })
            : {
                type: "sse" as const,
                url: config.url,
                headers: config.headers,
              };

        const client = await createMCPClient({
          transport,
          name,
          onUncaughtError: (err) => this._errorHandler(err as Error, { server: name }),
        });
        if (signal?.aborted) {
          await client
            .close()
            .catch((err: unknown) => this._errorHandler(err as Error, { server: name }));
          break;
        }
        const tools = await client.tools();
        Object.assign(this._tools, tools);
        this.clients.push({ name, config, client });
      } catch (err) {
        if (signal?.aborted) break;
        this._errorHandler(err as Error, { server: name });
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
    for (const { name, client } of this.clients) {
      try {
        await client.close();
      } catch (err) {
        this._errorHandler(err as Error, { server: name });
      }
    }
    this.clients = [];
    this._tools = {};
  }
}
