import type { ConfigManager } from "./config-manager.js";

export interface ApiKeyData {
  apiKey: string;
  provider: string;
  models: Array<{ type: string; model: string; size?: number }>;
}

export class SecretsManager {
  constructor(private config: ConfigManager) {}

  async getApiKey(): Promise<ApiKeyData | undefined> {
    return this.config.load<ApiKeyData>("/key.json");
  }

  async saveApiKey(data: ApiKeyData): Promise<void> {
    await this.config.save("/key.json", data);
  }

  async getCredentials(name: string): Promise<Record<string, string> | undefined> {
    return this.config.load<Record<string, string>>(`/credentials/${name}.json`);
  }

  async saveCredentials(name: string, data: Record<string, string>): Promise<void> {
    await this.config.save(`/credentials/${name}.json`, data);
  }
}
