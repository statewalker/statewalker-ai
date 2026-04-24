import type { EngineId } from "@statewalker/ai-provider";
import { type FilesApi, readText } from "@statewalker/webrun-files";

const MIGRATIONS_FILE = "/.settings/migrations.json";
const MIGRATIONS_DIR = "/.settings";
const ENGINE_IDS: readonly EngineId[] = ["tjs", "webllm", "llamacpp"];
const ENGINE_ID_SET = new Set<string>(ENGINE_IDS);

/** Marker id for the engine-namespacing migration. */
export const ENGINE_NAMESPACING = "engine-namespacing";

type MigrationMarkers = Record<string, { appliedAt: string }>;

/**
 * Move legacy `{basePath}/{modelId}/` directories into
 * `{basePath}/tjs/{modelId}/` so weights from before the multi-engine
 * refactor line up with `LocalModelStorage`'s engine-namespaced layout.
 *
 * Idempotent: records a marker in `/.settings/migrations.json` on first
 * successful run and returns immediately on subsequent calls.
 *
 * @returns `true` if the migration ran in this call, `false` if it was
 * already applied or `basePath` does not exist.
 */
export async function migrateEngineNamespacing(
  files: FilesApi,
  basePath: string = "/models",
): Promise<boolean> {
  const markers = await readMarkers(files);
  if (markers[ENGINE_NAMESPACING]) return false;

  if (await files.exists(basePath)) {
    const tjsRoot = `${basePath}/tjs`;
    await files.mkdir(tjsRoot);
    for await (const entry of files.list(basePath)) {
      if (entry.kind !== "directory") continue;
      if (ENGINE_ID_SET.has(entry.name)) continue;
      await files.move(entry.path, `${tjsRoot}/${entry.name}`);
    }
  }

  markers[ENGINE_NAMESPACING] = { appliedAt: new Date().toISOString() };
  await writeMarkers(files, markers);
  return true;
}

async function readMarkers(files: FilesApi): Promise<MigrationMarkers> {
  if (!(await files.exists(MIGRATIONS_FILE))) return {};
  try {
    const text = await readText(files, MIGRATIONS_FILE);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as MigrationMarkers) : {};
  } catch {
    return {};
  }
}

async function writeMarkers(files: FilesApi, markers: MigrationMarkers): Promise<void> {
  await files.mkdir(MIGRATIONS_DIR);
  const content = JSON.stringify(markers, null, 2);
  await files.write(MIGRATIONS_FILE, [new TextEncoder().encode(content)]);
}
