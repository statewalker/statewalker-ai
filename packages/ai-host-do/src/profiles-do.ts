// The deployment's profiles file system (statewalker/statewalker-root#157), mounted when the
// deployment starts from its configuration (PROFILES_BACKEND: "sql", the default, or "memory"), with
// one top-level folder per user. Only User DOs call it, each for its own user: every call is
// answered inside `profiles/<user>/`, by a files-RPC server per user.

import { DurableObject } from "cloudflare:workers";
import {
  FilesRpcHost,
  type FilesRpcMethod,
  filesRpcEndpoint,
  mountProfiles,
  normalise,
  profileFiles,
  profilePath,
} from "@statewalker/ai-environment";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import type { FilesApi } from "@statewalker/webrun-files";
import { newFilesRpcServer } from "@statewalker/webrun-files-rpc";
import { blockSizeOf, type Env } from "./env.js";

export class Profiles extends DurableObject<Env> {
  readonly #files: Promise<FilesApi>;
  readonly #servers: FilesRpcHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#files = mountProfiles(env.PROFILES_BACKEND, () => newDoSqliteDb(ctx.storage as never));
    this.#files.catch(() => {});
    this.#servers = new FilesRpcHost(async (user) =>
      filesRpcEndpoint(
        newFilesRpcServer({
          fs: profileFiles(await this.#files, user),
          chunkSize: blockSizeOf(env),
          maxChunkSize: Math.max(blockSizeOf(env), 4 * 1024 * 1024),
        }),
      ),
    );
  }

  /** One files-RPC call on a user's profile, rooted at their folder. */
  files(user: string, method: FilesRpcMethod, args: unknown[]): Promise<unknown> {
    profilePath(user);
    return this.#servers.call(user, method, args);
  }

  /** Erases a user's profile: their whole folder. */
  async erase(user: string): Promise<void> {
    await (await this.#files).remove(profilePath(user));
  }

  /** Test-only fixtures (the Worker admits this only with the ADMIN_KEY). */
  async seed(files: Record<string, string>): Promise<number> {
    const enc = new TextEncoder();
    const store = await this.#files;
    for (const [path, text] of Object.entries(files))
      await store.write(normalise(path), [enc.encode(text)]);
    return Object.keys(files).length;
  }
}
