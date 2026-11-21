// What a scenario needs for each workspace backend a deployment can be configured with: the vars
// to start it with, and a way to look at the backend itself (where one exists outside the
// deployment).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeS3 } from "./fake-s3.js";

export interface WorkspaceBackend {
  vars: Record<string, string>;
  /** Whether the backend holds a file at this path of the default workspace, when it can be seen. */
  holds?(path: string): Promise<boolean>;
  close(): Promise<void>;
}

/** The backend the vars name ("sql" when none), ready for a deployment. */
export async function workspaceBackend(vars: Record<string, string>): Promise<WorkspaceBackend> {
  const backend = vars.WORKSPACE_BACKEND || "sql";
  if (backend === "local") {
    const root = mkdtempSync(join(tmpdir(), "ai-workspaces-"));
    return {
      vars: { ...vars, WORKSPACE_ROOT: root },
      holds: async (path) => existsSync(join(root, "default", path)),
      close: async () => rmSync(root, { recursive: true, force: true }),
    };
  }
  if (backend === "s3") {
    const s3 = await fakeS3();
    return {
      vars: {
        ...vars,
        WORKSPACE_S3_ENDPOINT: s3.url,
        WORKSPACE_S3_BUCKET: "workspaces",
        WORKSPACE_S3_REGION: "us-east-1",
        WORKSPACE_S3_ACCESS_KEY_ID: "conformance",
        WORKSPACE_S3_SECRET_ACCESS_KEY: "conformance",
      },
      holds: async (path) => s3.keys("workspaces").includes(`default/${path}`),
      close: () => s3.close(),
    };
  }
  return { vars, close: async () => {} };
}
