import type { FilesApi } from "@statewalker/webrun-files";
import { parseSkillMarkdown } from "../skills/skill-parser.js";
import type { SkillInfo } from "../skills/skill-types.js";
import type { AgentRuntimeErrorContext, AgentRuntimeErrorHandler } from "./types.js";

/**
 * Resolves the runtime's `SkillInfo[]` from a `FilesApi` skills folder
 * plus any manually-registered skills. Walks the folder, parses each
 * `*.md` file, and appends to the manual list.
 *
 * Per-file errors flow through `onError` without aborting the walk.
 * Missing folder is treated as "no disk skills" — manual list is
 * returned unchanged.
 */
export class SkillsLoader {
  async load(
    systemFiles: FilesApi,
    skillsPath: string,
    manualSkills: SkillInfo[],
    onError: AgentRuntimeErrorHandler,
  ): Promise<SkillInfo[]> {
    const skills: SkillInfo[] = [...manualSkills];
    if (!(await systemFiles.exists(skillsPath))) return skills;
    for await (const entry of systemFiles.list(skillsPath)) {
      if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
      try {
        const text = await readFile(systemFiles, entry.path);
        const skill = parseSkillMarkdown(text, entry.path);
        if (skill) skills.push(skill);
      } catch (err) {
        onError(err as Error, { path: entry.path } as AgentRuntimeErrorContext);
      }
    }
    return skills;
  }
}

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
