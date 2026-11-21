// The deployment's profiles file system (statewalker/statewalker-root#157), mounted when the
// deployment starts from its configuration (PROFILES_BACKEND: "sql", the default, or "memory"), with
// one top-level folder per user. Only User DOs call it, each for its own user: every call is
// answered inside `profiles/<user>/`.

import { DurableObject } from "cloudflare:workers";
import {
  answerFileCall,
  type FileCall,
  mountProfiles,
  normalise,
  profileFiles,
  profilePath,
} from "@statewalker/ai-environment";
import type { FilesApi } from "@statewalker/webrun-files";
import type { Env } from "./env.js";

export class Profiles extends DurableObject<Env> {
  readonly #files: FilesApi;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#files = mountProfiles(env.PROFILES_BACKEND, ctx.storage.sql);
  }

  /** One file call on a user's profile, rooted at their folder. */
  fileCall(user: string, call: FileCall): Promise<unknown> {
    return answerFileCall(profileFiles(this.#files, user), call);
  }

  /** Erases a user's profile: their whole folder. */
  async erase(user: string): Promise<void> {
    await this.#files.remove(profilePath(user));
  }

  /** Test-only fixtures (the Worker admits this only with the ADMIN_KEY). */
  async seed(files: Record<string, string>): Promise<number> {
    const enc = new TextEncoder();
    for (const [path, text] of Object.entries(files))
      await this.#files.write(normalise(path), [enc.encode(text)]);
    return Object.keys(files).length;
  }
}
