// A workspace's store (statewalker/statewalker-root#80): one FilesApi per workspace, from the
// deployment's configuration (WORKSPACE_BACKEND), whose first-level folders are the projects.
// - "sql" (the default): SqlFs (webrun-files-sqlite) on the Workspace DO's own SQLite;
// - "memory": in memory, emptied when the Workspace DO restarts;
// - "local": the local file system (CellB Node, CellD), under WORKSPACE_ROOT/<workspace>/;
// - "s3": an S3 bucket (WORKSPACE_S3_BUCKET, optional WORKSPACE_S3_ENDPOINT, _REGION, _PREFIX),
//   under <prefix>/<workspace>/, with the keys WORKSPACE_S3_ACCESS_KEY_ID and
//   WORKSPACE_S3_SECRET_ACCESS_KEY (secrets, never vars).
// The store knows nothing of rights: only the gate in the Workspace DO calls it, and its
// credentials never leave the DO.
import { codedError } from "@statewalker/ai-access";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { S3FilesApi } from "@statewalker/webrun-files-s3";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import type { Env } from "./env.js";
import { FetchS3Client } from "./s3-client.js";

export async function mountWorkspace(
  env: Env,
  storage: DurableObjectStorage,
  workspace: string,
): Promise<FilesApi> {
  const backend = env.WORKSPACE_BACKEND || "sql";
  if (backend === "sql") {
    const files = new SqliteFilesApi(newDoSqliteDb(storage as never), { tablePrefix: "ws_fs_" });
    await files.init();
    return files;
  }
  if (backend === "memory") return new MemFilesApi();
  if (backend === "local") {
    if (!env.WORKSPACE_ROOT) throw codedError("EIO", "WORKSPACE_ROOT is required for 'local'");
    const [{ NodeFilesApi }, { mkdir }, { join }] = await Promise.all([
      import("@statewalker/webrun-files-node"),
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const rootDir = join(env.WORKSPACE_ROOT, workspace);
    await mkdir(rootDir, { recursive: true });
    return new NodeFilesApi({ rootDir });
  }
  if (backend === "s3") {
    if (!env.WORKSPACE_S3_BUCKET)
      throw codedError("EIO", "WORKSPACE_S3_BUCKET is required for 's3'");
    const client = new FetchS3Client({
      region: env.WORKSPACE_S3_REGION || "us-east-1",
      endpoint: env.WORKSPACE_S3_ENDPOINT || undefined,
      accessKeyId: env.WORKSPACE_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.WORKSPACE_S3_SECRET_ACCESS_KEY ?? "",
    });
    const prefix = [env.WORKSPACE_S3_PREFIX, workspace].filter(Boolean).join("/");
    return new S3FilesApi({ client: client as never, bucket: env.WORKSPACE_S3_BUCKET, prefix });
  }
  throw codedError("EIO", `unknown workspace backend '${backend}'`);
}
