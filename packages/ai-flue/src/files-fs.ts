// just-bash's IFileSystem over a FilesApi: what Flue's sandbox runs on. The FilesApi is the gated
// file view the agent session holds (every call goes to the Workspace DO's gate), so there is no
// other file system underneath. Read verbs only, until the view takes writes (a later ticket).
// Ported from statewalker-sandbox apps/flue-capfs-do/src/capfs.ts.
import { normalise } from "@statewalker/ai-environment";
import { type FilesApi, readFile } from "@statewalker/webrun-files";

const enoent = (p: string) => new Error(`ENOENT: no such file or directory, '${p}'`);
const readOnly = async (): Promise<never> => {
  throw new Error("ENOSYS: the file view is read-only for now");
};

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

  writeFile = readOnly;
  appendFile = readOnly;
  mkdir = readOnly;
  rm = readOnly;
  cp = readOnly;
  mv = readOnly;
  chmod = readOnly;
  utimes = readOnly;
  symlink = readOnly;
  link = readOnly;
  async readlink(p: string): Promise<string> {
    throw new Error(`EINVAL: not a symlink '${p}'`);
  }
}
