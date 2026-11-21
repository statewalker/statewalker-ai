// just-bash's IFileSystem over a FilesApi: what Flue's sandbox runs on. The FilesApi is the gated
// file view the agent session holds (every call goes to the Workspace DO's gate), so there is no
// other file system underneath. Reads, writes, folders and deletes go to the gate, which decides
// each by the roles, the rules and the mode (statewalker/statewalker-root#124); copy and move wait
// for the view to take them.
// Ported from statewalker-sandbox apps/flue-capfs-do/src/capfs.ts.
import { normalise } from "@statewalker/ai-environment";
import { type FilesApi, readFile } from "@statewalker/webrun-files";

const enoent = (p: string) => new Error(`ENOENT: no such file or directory, '${p}'`);
const notYet = async (): Promise<never> => {
  throw new Error("ENOSYS: not supported by the file view yet");
};

const bytesOf = (content: string | Uint8Array) =>
  typeof content === "string" ? new TextEncoder().encode(content) : content;

export class FilesFs {
  readonly #files: FilesApi;

  constructor(files: FilesApi) {
    this.#files = files;
  }

  async readFileBuffer(p: string): Promise<Uint8Array> {
    const stats = await this.#files.stats(p);
    if (!stats) throw enoent(p);
    if (stats.kind !== "file") throw new Error(`EISDIR: illegal operation on a directory, '${p}'`);
    return readFile(this.#files, p);
  }

  async readFile(p: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(p));
  }

  async exists(p: string): Promise<boolean> {
    try {
      return await this.#files.exists(p);
    } catch {
      return false;
    }
  }

  async stat(p: string) {
    const s = await this.#files.stats(p);
    if (!s) throw enoent(p);
    const file = s.kind === "file";
    return {
      isFile: file,
      isDirectory: !file,
      isSymbolicLink: false,
      size: file ? s.size : 0,
      mode: file ? 0o644 : 0o755,
      mtime: new Date(file ? s.lastModified : 0),
    };
  }

  lstat(p: string) {
    return this.stat(p);
  }

  async realpath(p: string): Promise<string> {
    await this.stat(p);
    return normalise(p);
  }

  async readdir(p: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(p)).map((e) => e.name);
  }

  async readdirWithFileTypes(p: string) {
    if ((await this.stat(p)).isFile) throw new Error(`ENOTDIR: not a directory, '${p}'`);
    const out: { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[] =
      [];
    for await (const e of this.#files.list(p))
      out.push({
        name: e.name,
        isFile: e.kind === "file",
        isDirectory: e.kind === "directory",
        isSymbolicLink: false,
      });
    return out;
  }

  resolvePath(base: string, p: string): string {
    return normalise(p.startsWith("/") ? p : `${base}/${p}`);
  }

  // Synchronous in the interface, so it cannot go to the gate; no just-bash command needs it here.
  getAllPaths(): string[] {
    return [];
  }

  async writeFile(p: string, content: string | Uint8Array): Promise<void> {
    await this.#files.write(normalise(p), [bytesOf(content)]);
  }

  async appendFile(p: string, content: string | Uint8Array): Promise<void> {
    const before = (await this.#files.stats(p)) ? await this.readFileBuffer(p) : new Uint8Array();
    const add = bytesOf(content);
    const all = new Uint8Array(before.length + add.length);
    all.set(before);
    all.set(add, before.length);
    await this.#files.write(normalise(p), [all]);
  }

  /** `mkdir -p` of an existing folder is sent too: the gate answers it without asking. */
  async mkdir(p: string, options?: { recursive?: boolean }): Promise<void> {
    if (!options?.recursive && (await this.#files.stats(p)))
      throw new Error(`EEXIST: file already exists, mkdir '${p}'`);
    await this.#files.mkdir(normalise(p));
  }

  async rm(p: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const stats = await this.#files.stats(p);
    if (!stats) {
      if (options?.force) return;
      throw enoent(p);
    }
    if (stats.kind === "directory" && !options?.recursive) {
      for await (const _ of this.#files.list(p))
        throw new Error(`ENOTEMPTY: directory not empty, rm '${p}'`);
    }
    await this.#files.remove(normalise(p));
  }

  cp = notYet;
  mv = notYet;
  chmod = notYet;
  utimes = notYet;
  symlink = notYet;
  link = notYet;
  async readlink(p: string): Promise<string> {
    throw new Error(`EINVAL: not a symlink '${p}'`);
  }
}
