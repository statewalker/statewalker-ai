// just-bash's IFileSystem over a FilesApi: what Flue's sandbox runs on. The FilesApi is the gated
// file view the agent session holds (every call goes to the Workspace DO's gate), so there is no
// other file system underneath: whatever a command does (ls, globs, rm -r, cp, mv) is an operation
// the gate decides, entry by entry. No symbolic or hard links.
// Ported from statewalker-sandbox apps/flue-capfs-do/src/capfs.ts.
import { normalise } from "@statewalker/ai-environment";
import { type FilesApi, readFile } from "@statewalker/webrun-files";

const enoent = (p: string) => new Error(`ENOENT: no such file or directory, '${p}'`);
const noLinks = async (): Promise<never> => {
  throw new Error("ENOSYS: the file view has no links");
};
type Encoding = string | { encoding?: string | null } | null | undefined;
const encodingOf = (options: Encoding) =>
  (typeof options === "string" ? options : options?.encoding) ?? "utf8";

/** One byte per character: how just-bash carries bytes it pipes onward (its ByteString). */
const latin1 = (bytes: Uint8Array) => {
  let out = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return out;
};

/**
 * The bytes of content just-bash writes: text in its encoding, so a redirect of binary output
 * (`binary`/`latin1`, one byte per character) is stored byte for byte, never as UTF-8 of it.
 */
const bytesOf = (content: string | Uint8Array, options?: Encoding): Uint8Array => {
  if (typeof content !== "string") return content;
  switch (encodingOf(options).toLowerCase()) {
    case "binary":
    case "latin1":
      return Uint8Array.from(content, (c) => c.charCodeAt(0) & 0xff);
    case "ascii":
      return Uint8Array.from(content, (c) => c.charCodeAt(0) & 0x7f);
    case "hex":
      return Uint8Array.from(content.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
    case "base64":
      return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
    default:
      return new TextEncoder().encode(content);
  }
};

/** A FilesApi that may append itself (the gate's file view does, one append at a time per file). */
type Files = FilesApi & {
  append?(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;
};

export class FilesFs {
  readonly #files: Files;

  constructor(files: Files) {
    this.#files = files;
  }

  async readFileBuffer(p: string): Promise<Uint8Array> {
    const stats = await this.#files.stats(p);
    if (!stats) throw enoent(p);
    if (stats.kind !== "file") throw new Error(`EISDIR: illegal operation on a directory, '${p}'`);
    return readFile(this.#files, p);
  }

  async readFile(p: string, options?: Encoding): Promise<string> {
    const bytes = await this.readFileBuffer(p);
    switch (encodingOf(options).toLowerCase()) {
      case "binary":
      case "latin1":
        return latin1(bytes);
      default:
        return new TextDecoder().decode(bytes);
    }
  }

  /** The file's bytes, one per character, for just-bash to pipe onward unchanged. */
  async readFileBytes(p: string): Promise<string> {
    return latin1(await this.readFileBuffer(p));
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
      // The view has no links: a normalised path names one entry, so it is the entry's identity
      // (what `cp` and `mv` compare to tell whether source and target are the same file).
      identity: normalise(p),
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

  async writeFile(p: string, content: string | Uint8Array, options?: Encoding): Promise<void> {
    await this.#files.write(p, [bytesOf(content, options)]);
  }

  async appendFile(p: string, content: string | Uint8Array, options?: Encoding): Promise<void> {
    const added = bytesOf(content, options);
    // Appending nothing changes nothing (just-bash opens a `>>` redirect so): no change to decide.
    if (added.length === 0 && (await this.#files.exists(p))) return;
    // One change at the gate: appends of parallel sessions to one file lose nothing.
    if (this.#files.append) return this.#files.append(p, [added]);
    const before = (await this.#files.exists(p)) ? await this.readFileBuffer(p) : new Uint8Array();
    const all = new Uint8Array(before.length + added.length);
    all.set(before);
    all.set(added, before.length);
    await this.#files.write(p, [all]);
  }

  async mkdir(p: string, options?: { recursive?: boolean }): Promise<void> {
    const s = await this.#files.stats(p);
    if (s) {
      if (options?.recursive && s.kind === "directory") return;
      throw new Error(`EEXIST: file already exists, '${p}'`);
    }
    const parent = normalise(p).replace(/\/[^/]*$/, "") || "/";
    if (!options?.recursive && (await this.#files.stats(parent))?.kind !== "directory")
      throw enoent(p);
    await this.#files.mkdir(p);
  }

  async rm(p: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const s = await this.#files.stats(p);
    if (!s) {
      if (options?.force) return;
      throw enoent(p);
    }
    if (s.kind === "directory" && !options?.recursive)
      throw new Error(`EISDIR: is a directory, '${p}'`);
    await this.#files.remove(p);
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const s = await this.#files.stats(src);
    if (!s) throw enoent(src);
    if (s.kind === "directory" && !options?.recursive)
      throw new Error(`EISDIR: is a directory, '${src}'`);
    if (!(await this.#files.copy(src, dest))) throw enoent(src);
  }

  async mv(src: string, dest: string): Promise<void> {
    if (!(await this.#files.move(src, dest))) throw enoent(src);
  }

  async chmod(p: string): Promise<void> {
    await this.stat(p);
  }

  async utimes(p: string): Promise<void> {
    await this.stat(p);
  }

  symlink = noLinks;
  link = noLinks;
  async readlink(p: string): Promise<string> {
    throw new Error(`EINVAL: not a symlink '${p}'`);
  }
}
