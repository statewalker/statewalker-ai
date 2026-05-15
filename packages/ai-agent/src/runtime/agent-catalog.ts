import type { FilesApi } from "@statewalker/webrun-files";
import { parseSkillMarkdown } from "../skills/skill-parser.js";
import { Agent } from "./agent.js";
import type { AgentRuntime } from "./agent-runtime.js";
import type {
  AgentDefinition,
  AgentRuntimeErrorContext,
  AgentRuntimeErrorHandler,
} from "./types.js";

/**
 * Registry + disk loader for {@link Agent} definitions.
 *
 * Owns the name → `Agent` map, dup-name validation, and the optional
 * markdown-folder loader. Constructed once per {@link AgentRuntime};
 * the runtime delegates `createAgent / getAgent / agents` to this class.
 */
export class AgentCatalog {
  private readonly _agents = new Map<string, Agent>();

  /** Register a new Agent definition. Throws on duplicate name. */
  register(def: AgentDefinition, runtime: AgentRuntime): Agent {
    if (this._agents.has(def.name)) {
      throw new Error(`AgentCatalog: agent already registered: ${def.name}`);
    }
    const agent = new Agent(def, runtime);
    this._agents.set(def.name, agent);
    return agent;
  }

  /** Return a registered Agent by name, or `undefined`. */
  get(name: string): Agent | undefined {
    return this._agents.get(name);
  }

  /** Return all registered Agents. */
  all(): Agent[] {
    return [...this._agents.values()];
  }

  /**
   * Walk `agentsPath` on `systemFiles` and register each `*.md` file as
   * an Agent definition. Names already present are skipped (so
   * programmatic `register(...)` wins over disk loading). Per-file
   * errors flow through `onError` without aborting the walk.
   */
  async loadFromDisk(
    systemFiles: FilesApi,
    agentsPath: string,
    runtime: AgentRuntime,
    onError: AgentRuntimeErrorHandler,
  ): Promise<void> {
    if (!(await systemFiles.exists(agentsPath))) return;
    for await (const entry of systemFiles.list(agentsPath)) {
      if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
      try {
        const text = await readFile(systemFiles, entry.path);
        const def = parseAgentMarkdown(text, entry.name.replace(/\.md$/, ""));
        if (def && !this._agents.has(def.name)) {
          this._agents.set(def.name, new Agent(def, runtime));
        }
      } catch (err) {
        onError(err as Error, { path: entry.path } as AgentRuntimeErrorContext);
      }
    }
  }
}

// ── Module-private helpers ───────────────────────────────────────────────

async function readFile(files: FilesApi, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(path)) chunks.push(chunk);
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Parse an Agent definition file (markdown with key=value frontmatter
 * delimited by `---` lines). Falls back to no definition if the file is
 * not recognizable as such — the caller treats `null` as "skip".
 */
function parseAgentMarkdown(text: string, fallbackName: string): AgentDefinition | null {
  const parsed = parseSkillMarkdown(text, fallbackName);
  if (!parsed) return null;
  const def: AgentDefinition = { name: parsed.name ?? fallbackName };
  if (parsed.description) def.systemPrompt = parsed.content ?? parsed.description;
  return def;
}
