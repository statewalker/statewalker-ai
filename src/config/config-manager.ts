import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadText, writeText } from "@statewalker/webrun-files";
import type { ZodType } from "zod";

export class ConfigManager {
  constructor(
    private files: FilesApi,
    private basePath = "/",
  ) {}

  private resolvePath(path: string): string {
    if (this.basePath === "/") return path;
    return `${this.basePath}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async load<T>(path: string, schema?: ZodType<T>): Promise<T | undefined> {
    const resolved = this.resolvePath(path);
    const text = await tryReadText(this.files, resolved);
    if (text === undefined) return undefined;
    try {
      const data = JSON.parse(text);
      if (schema) {
        const result = schema.safeParse(data);
        return result.success ? result.data : undefined;
      }
      return data as T;
    } catch {
      return undefined;
    }
  }

  async save(path: string, data: unknown): Promise<void> {
    const resolved = this.resolvePath(path);
    await writeText(this.files, resolved, JSON.stringify(data, null, 2));
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.resolvePath(path);
    return this.files.exists(resolved);
  }

  async delete(path: string): Promise<boolean> {
    const resolved = this.resolvePath(path);
    return this.files.remove(resolved);
  }
}
