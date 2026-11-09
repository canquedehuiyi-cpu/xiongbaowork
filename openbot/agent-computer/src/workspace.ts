/**
 * The Bot's files, and the boundary they must not escape.
 *
 * The computer has a `/workspace` volume so that anything a Bot should still have next week
 * survives the container. A Bot can read and write in it, which turns a durable directory into an
 * attack surface: the process runs as root inside its container, so `write_file("../../etc/passwd")`
 * is the obvious first thing to try and `read_file("../../root/.ssh/id_rsa")` the second.
 *
 * Path confinement is enforced in three layers:
 *
 *  1. Absolute paths are refused outright. A Bot names a file relative to its own workspace; there is
 *     no legitimate request that begins with `/`.
 *  2. The resolved path must be inside the root lexically. This catches `..` traversal.
 *  3. The resolved path must still be inside the root after symlinks are followed. This is the layer
 *     people miss: a symlink placed inside the workspace (by an earlier write, or by a page the Bot
 *     downloaded something from) passes the lexical check and then points anywhere on the filesystem.
 *     For a write, the file may not exist yet, so the deepest existing ancestor gets resolved, which
 *     is the directory the write will land in, AND the name itself is resolved when something is
 *     already there, because `writeFile` follows a link at the last component too.
 *
 * A factory taking its root as an argument rather than reading the environment, so the confinement
 * can be tested against a temporary directory instead of being taken on trust.
 */
import {
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

export class WorkspaceFileNotFoundError extends WorkspaceFileError {}

export class WorkspaceFileTooLargeError extends WorkspaceFileError {}

export type WorkspaceLimits = {
  /**
   * Most bytes a read hands back.
   *
   * Bounded for the same reason page text is: the contents go into a model's context, and one large
   * file would push the rest of the conversation out of it.
   */
  readBytes: number;
  /** Most bytes a single write accepts, so a loop cannot fill the volume. */
  writeBytes: number;
  /** Most entries a listing describes, so a Bot cannot paste a whole disk into its own context. */
  listEntries: number;
  /** Most bytes one download may stream, so a large artifact cannot exhaust the connection. */
  downloadBytes: number;
};

/**
 * One thing in the workspace. Folders included so a Bot can see the shape, not just the leaves.
 *
 * Mirrors `WorkspaceEntry` in the server's published contract (`server/src/computer/schema.ts`), the
 * same way `SnapshotElement` does. Duplicated rather than shared because this process is a separate
 * deployable with no code in common with the server; the two must be changed together, and a field
 * added here and not there is invisible until a Bot asks for it.
 */
export type WorkspaceEntry = {
  /** Relative to the workspace root, which is the only form a request may use. */
  path: string;
  kind: "file" | "folder";
  bytes?: number;
};

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  readBytes: 64_000,
  writeBytes: 1_000_000,
  listEntries: 500,
  downloadBytes: 100 * 1024 * 1024,
};

export type WorkspaceOptions = {
  /**
   * Check the file that was opened, not only the path before it was opened. Per-employee mode only.
   *
   * There, the file tools run as the computer's own user, which can reach every employee's
   * directory, while the paths inside an employee's directory are that employee's to change. A path
   * checked and then opened by name leaves a window in which `d` is a real directory for the check
   * and a link to another employee's directory for the open. So the file is opened first, the path
   * the kernel actually opened is read back from `/proc/self/fd`, and it must still be inside the
   * root before a byte is read or written. Linux only, as per-employee mode is.
   *
   * Off in the shared workspace: there every command already runs as the same user as the file
   * tools, so there is no one to race and nothing to gain.
   */
  confineOpened?: boolean;
  /**
   * For tests: called in confined mode with each path just before it is looked up: before a file is
   * opened, and for a folder a write creates, both before it is made and before it is opened.
   */
  beforeOpen?: (path: string) => void | Promise<void>;
};

const {
  O_APPEND,
  O_CREAT,
  O_EXCL,
  O_NOCTTY,
  O_NOFOLLOW,
  O_NONBLOCK,
  O_RDONLY,
  O_WRONLY,
} = constants;

/**
 * `O_NONBLOCK` so a named pipe an employee left behind is refused rather than an open that waits
 * for a writer for ever. It changes nothing for a regular file or a directory.
 */
const READ_FLAGS = O_RDONLY | O_NONBLOCK | O_NOCTTY;

/** Where the kernel says an open descriptor points, links and all resolved. */
function openedPath(handle: FileHandle): Promise<string> {
  return readlink(`/proc/self/fd/${handle.fd}`);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * What an open that failed tells the caller: a missing file is missing, and anything else (a pipe
 * with no reader, a loop of links) a file that could not be opened, rather than a broken computer.
 */
function openFailure(error: unknown, shown: string): WorkspaceFileError {
  if (errorCode(error) === "ENOENT")
    return new WorkspaceFileNotFoundError(`There is no file at ${shown}.`);
  return new WorkspaceFileError(`${shown} could not be opened.`);
}

function changedUnderneath(shown: string): WorkspacePathError {
  return new WorkspacePathError(
    `${shown} changed while it was being opened, and now leads outside your workspace.`,
  );
}

export function createWorkspace(
  rootPath: string,
  limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS,
  options: WorkspaceOptions = {},
) {
  const confined = options.confineOpened === true;

  /** Open `path` and prove that what was opened is inside `root`, or close it and refuse. */
  async function openInside(
    root: string,
    path: string,
    flags: number,
    shown: string,
  ): Promise<FileHandle> {
    await options.beforeOpen?.(path);
    let handle: FileHandle;
    try {
      handle = await open(path, flags);
    } catch (error) {
      throw openFailure(error, shown);
    }
    try {
      const real = await openedPath(handle);
      try {
        assertInside(root, real, shown);
      } catch {
        throw changedUnderneath(shown);
      }
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Create the folders a write needs one at a time, each inside the folder before it.
   *
   * Each folder is made and opened through the descriptor of the folder above it
   * (`/proc/self/fd/<fd>/<name>`), so a folder swapped for a link once it was checked cannot aim the
   * next one somewhere else. What was opened is then checked like any other open. A folder that was
   * made here and then swapped for a link before it could be opened leads somewhere this employee
   * chose, possibly another employee's folder, so it is refused and nothing is removed: removing it
   * would remove theirs.
   */
  async function makeFoldersInside(
    root: string,
    folder: string,
    shown: string,
  ): Promise<void> {
    const rel = relative(root, folder);
    if (rel === "") return;
    let parent = await openInside(root, root, READ_FLAGS, shown);
    try {
      let current = root;
      for (const part of rel.split(sep)) {
        const next = join(current, part);
        const viaParent = `/proc/self/fd/${parent.fd}/${part}`;
        await options.beforeOpen?.(next);
        try {
          await mkdir(viaParent);
        } catch (error) {
          if (errorCode(error) !== "EEXIST")
            throw new WorkspaceFileError(`${shown} could not be created.`);
        }
        await options.beforeOpen?.(next);
        let handle: FileHandle;
        try {
          handle = await open(viaParent, READ_FLAGS);
        } catch {
          throw new WorkspaceFileError(`${shown} could not be created.`);
        }
        try {
          const real = await openedPath(handle);
          try {
            assertInside(root, real, shown);
          } catch {
            throw changedUnderneath(shown);
          }
          if (!(await handle.stat()).isDirectory())
            throw new WorkspaceFileError(
              `${relative(root, real)} is a file, not a folder.`,
            );
          current = real;
        } catch (error) {
          await handle.close().catch(() => {});
          throw error;
        }
        await parent.close().catch(() => {});
        parent = handle;
      }
    } finally {
      await parent.close().catch(() => {});
    }
  }

  /** Up to `length` bytes from the start of an open file. */
  async function readStart(
    handle: FileHandle,
    length: number,
  ): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        length - filled,
        filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  }

  /**
   * Turn a Bot's requested path into a real one inside the workspace, or refuse.
   *
   * `forWrite` changes only which part of the path must already exist: a read resolves the file
   * itself, a write resolves the directory it would be created in.
   */
  async function resolvePath(
    requested: string,
    forWrite: boolean,
  ): Promise<string> {
    if (typeof requested !== "string" || !requested.trim()) {
      throw new WorkspacePathError("A file path is required.");
    }
    const wanted = requested.trim();

    if (isAbsolute(wanted)) {
      throw new WorkspacePathError(
        "Use a path relative to your workspace, not an absolute one.",
      );
    }
    // Refused explicitly rather than left to the containment check, so the Bot is told what it did
    // wrong and can correct it, instead of receiving a generic denial it may retry verbatim.
    if (wanted.split(/[\\/]/).includes("..")) {
      throw new WorkspacePathError(
        "A file path may not contain '..'. You can only reach files inside your own workspace.",
      );
    }

    const root = await realpath(rootPath);
    const target = resolve(root, wanted);
    assertInside(root, target);

    // Layer three. Resolve what exists on disk and check again, because everything above
    // reasons about the path as text and a symlink makes the text a lie.
    const anchor = forWrite ? dirname(target) : target;
    let realAnchor: string;
    try {
      realAnchor = await realpath(anchor);
    } catch {
      if (!forWrite) {
        throw new WorkspaceFileNotFoundError(`There is no file at ${wanted}.`);
      }
      // The parent directory does not exist yet. Walk up to the nearest one that does and verify it,
      // so a write into a new subdirectory is allowed but cannot be aimed through a symlink.
      realAnchor = await nearestExistingAncestor(root, anchor);
    }
    assertInside(root, realAnchor, wanted);

    if (!forWrite) return realAnchor;

    /*
     * Layer three again, for the last component rather than the directory holding it.
     *
     * Containing `dirname(target)` proves where a NEW file would be created. It proves nothing about
     * a name that already exists, and `writeFile` follows a symlink at the last component the same
     * way `readFile` does. A link at `notes.txt` pointing at `/root/.ssh/authorized_keys` passes
     * every check above, having no `..`, not being absolute, and sitting directly in the workspace,
     * and the bytes land outside the volume. The read side already refuses the identical link; the
     * write side was the asymmetry.
     *
     * The link has to get there first, which takes a shell or an archive that was unpacked with one,
     * so this is not a fresh escape for a Bot that already has `run_command`: that Bot can write
     * outside directly. What it is, is a hole in what the gateway can still see. The decision and the
     * audit row are both made against the path as the Bot asked for it, so a rule written for
     * `credentials/` or `*.env` is evaluated against `notes.txt` and never sees the file that gets
     * written, and the row names a file in the workspace that nothing touched. A deployment that
     * denies `run_command` and allows writes is relying on exactly that, and so is one reading the
     * trail afterwards. A permissive workspace is a decision a deployment can make. A trail that
     * describes a different file from the one on disk is not.
     */
    const landing = await writeDestination(target, wanted);
    if (landing === target) return target;

    // A link was followed, so the destination gets the checks the requested path already passed:
    // inside lexically, and inside after the directory holding it is resolved.
    /*
     * The holder is resolved BEFORE either check. `root` is a real path, so comparing it against a
     * destination that still runs through a symlinked ancestor refuses a link that points straight
     * back inside, which is what happens wherever the workspace sits behind one.
     */
    const holder = await realpath(dirname(landing)).catch(() => null);
    if (holder === null) {
      throw new WorkspacePathError(
        `${wanted} points at somewhere that does not exist, so where a write would land cannot be established.`,
      );
    }
    assertInside(root, holder, wanted);
    const resolved = join(holder, basename(landing));
    assertInside(root, resolved, wanted);
    return resolved;
  }

  /** `list`, walking open folders rather than paths. */
  async function listOpened(
    root: string,
    start: string,
    requested: string,
  ): Promise<{ path: string; entries: WorkspaceEntry[]; truncated: boolean }> {
    let first: FileHandle;
    try {
      first = await openInside(root, start, READ_FLAGS, requested);
    } catch (error) {
      if (error instanceof WorkspaceFileNotFoundError)
        throw new WorkspaceFileError(`There is no folder at ${requested}.`);
      throw error;
    }

    const entries: WorkspaceEntry[] = [];
    let truncated = false;

    /*
     * Each folder is read through its own descriptor (`/proc/self/fd/<fd>`), and a folder inside it
     * is opened relative to that descriptor with O_NOFOLLOW, so no path is looked up twice. A folder
     * that became a link since it was listed is not walked into, as a link never was.
     */
    const walk = async (handle: FileHandle, real: string): Promise<void> => {
      if (truncated) return;
      const here = `/proc/self/fd/${handle.fd}`;
      const found = await readdir(here, { withFileTypes: true });
      for (const item of found) {
        if (entries.length >= limits.listEntries) {
          truncated = true;
          return;
        }
        const full = join(real, item.name);
        const shown = full.slice(root.length + 1);
        if (item.isDirectory()) {
          entries.push({ path: shown, kind: "folder" });
          await options.beforeOpen?.(full);
          const child = await open(
            join(here, item.name),
            READ_FLAGS | O_NOFOLLOW,
          ).catch(() => null);
          if (child === null) continue;
          try {
            const childReal = await openedPath(child);
            try {
              assertInside(root, childReal, shown);
            } catch {
              throw changedUnderneath(shown);
            }
            if ((await child.stat()).isDirectory())
              await walk(child, childReal);
          } finally {
            await child.close().catch(() => {});
          }
          continue;
        }
        if (!item.isFile()) continue;
        const size = await lstat(join(here, item.name)).catch(() => null);
        entries.push({
          path: shown,
          kind: "file",
          ...(size?.isFile() ? { bytes: size.size } : {}),
        });
      }
    };

    try {
      if (!(await first.stat()).isDirectory())
        throw new WorkspaceFileError(`${requested} is a file, not a folder.`);
      await walk(first, await openedPath(first));
    } finally {
      await first.close().catch(() => {});
    }
    return { path: requested, entries, truncated };
  }

  /** `read`, from the descriptor that was checked. */
  async function readOpened(
    full: string,
    requested: string,
  ): Promise<{
    path: string;
    text: string;
    truncated: boolean;
    bytes: number;
  }> {
    const root = await realpath(rootPath);
    const handle = await openInside(root, full, READ_FLAGS, requested);
    try {
      const info = await handle.stat();
      if (info.isDirectory())
        throw new WorkspaceFileError(
          `${requested} is a directory, not a file.`,
        );
      if (!info.isFile())
        throw new WorkspaceFileError(`${requested} is not a file.`);
      const slice = await readStart(
        handle,
        Math.min(info.size, limits.readBytes),
      );
      return {
        path: requested,
        text: slice.toString("utf8"),
        truncated: info.size > slice.byteLength,
        bytes: info.size,
      };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /**
   * `download`, streamed from the descriptor that was checked. A `Bun.file` would open the path
   * again when the response is sent, which is the window this closes. The stream owns the
   * descriptor: it closes it at the end, or when the reader goes away.
   */
  async function downloadOpened(
    full: string,
    requested: string,
  ): Promise<{
    path: string;
    name: string;
    bytes: number;
    body: ReadableStream<Uint8Array>;
  }> {
    const root = await realpath(rootPath);
    const handle = await openInside(root, full, READ_FLAGS, requested);
    let size: number;
    try {
      const info = await handle.stat();
      if (!info.isFile())
        throw new WorkspaceFileError(`${requested} is not a file.`);
      if (info.size > limits.downloadBytes)
        throw new WorkspaceFileTooLargeError(
          `That file is ${info.size} bytes and the download limit is ${limits.downloadBytes}.`,
        );
      size = info.size;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }

    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // No more than the length the response announced, even if the file grew since.
        const want = Math.min(64 * 1024, size - sent);
        const chunk = want > 0 ? Buffer.alloc(want) : Buffer.alloc(0);
        const { bytesRead } =
          want > 0 ? await handle.read(chunk, 0, want, sent) : { bytesRead: 0 };
        if (bytesRead === 0) {
          await handle.close().catch(() => {});
          controller.close();
          return;
        }
        sent += bytesRead;
        controller.enqueue(chunk.subarray(0, bytesRead));
      },
      async cancel() {
        await handle.close().catch(() => {});
      },
    });
    return {
      path: requested,
      name: basename(requested.replace(/\\/g, "/")) || "download",
      bytes: size,
      body,
    };
  }

  /**
   * `write`, into the descriptor that was checked.
   *
   * Opened without O_TRUNC, so a file that turns out to be outside is never emptied; truncated only
   * once it is known to be this employee's. A file this call created and then found outside is
   * removed again, by the path the kernel reports for it: that path runs through the other
   * employee's directory, which this employee cannot change.
   */
  async function writeOpened(
    full: string,
    requested: string,
    contents: string,
    append: boolean,
  ): Promise<void> {
    const root = await realpath(rootPath);
    await makeFoldersInside(root, dirname(full), requested);
    const flags = O_WRONLY | O_NONBLOCK | O_NOCTTY | (append ? O_APPEND : 0);
    await options.beforeOpen?.(full);
    let handle: FileHandle;
    let created = false;
    try {
      handle = await open(full, flags | O_CREAT | O_EXCL, 0o666);
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw openFailure(error, requested);
      handle = await open(full, flags).catch((again: unknown) => {
        throw openFailure(again, requested);
      });
    }
    try {
      const real = await openedPath(handle);
      try {
        assertInside(root, real, requested);
      } catch {
        if (created) await unlink(real).catch(() => {});
        throw changedUnderneath(requested);
      }
      const info = await handle.stat();
      if (!info.isFile())
        throw new WorkspaceFileError(`${requested} is not a file.`);
      if (!append && !created) await handle.truncate(0);
      await handle.writeFile(contents, { encoding: "utf8" });
    } finally {
      await handle.close().catch(() => {});
    }
  }

  return {
    resolvePath,

    /**
     * What is in the workspace.
     *
     * Recursive, because a Bot that saved `reports/august/summary.csv` needs to find it again, and a
     * listing that stops at the first level would show a `reports` directory and no way in. Bounded by
     * entry count for the same reason everything else here is bounded.
     */
    async list(requested = "."): Promise<{
      path: string;
      entries: WorkspaceEntry[];
      truncated: boolean;
    }> {
      const root = await realpath(rootPath);
      // "." and "" both mean the workspace itself, which `resolvePath` would reject as a bare relative
      // path with nothing in it. Anything else goes through the same confinement as a read.
      const start =
        requested === "." || requested.trim() === ""
          ? root
          : await resolvePath(requested, false);
      if (confined) return listOpened(root, start, requested);

      const info = await stat(start).catch(() => null);
      if (!info) {
        throw new WorkspaceFileError(`There is no folder at ${requested}.`);
      }
      if (!info.isDirectory()) {
        throw new WorkspaceFileError(`${requested} is a file, not a folder.`);
      }

      const entries: WorkspaceEntry[] = [];
      let truncated = false;

      const walk = async (dir: string): Promise<void> => {
        if (truncated) return;
        const found = await readdir(dir, { withFileTypes: true });
        for (const item of found) {
          if (entries.length >= limits.listEntries) {
            truncated = true;
            return;
          }
          const full = `${dir}/${item.name}`;
          // Relative to the workspace root, because that is the only form a Bot may name in a request.
          const shown = full.slice(root.length + 1);
          if (item.isDirectory()) {
            entries.push({ path: shown, kind: "folder" });
            await walk(full);
            continue;
          }
          if (!item.isFile()) continue;
          const size = await stat(full).catch(() => null);
          entries.push({
            path: shown,
            kind: "file",
            ...(size ? { bytes: size.size } : {}),
          });
        }
      };

      await walk(start);
      return { path: requested, entries, truncated };
    },

    /** Read a text file. Bounded, and it says when it gave you less than the whole thing. */
    async read(requested: string): Promise<{
      path: string;
      text: string;
      truncated: boolean;
      bytes: number;
    }> {
      const full = await resolvePath(requested, false);
      if (confined) return readOpened(full, requested);
      const info = await stat(full).catch(() => null);
      if (!info) {
        throw new WorkspaceFileError(`There is no file at ${requested}.`);
      }
      if (info.isDirectory()) {
        throw new WorkspaceFileError(
          `${requested} is a directory, not a file.`,
        );
      }

      const buffer = await readFile(full);
      const slice = buffer.subarray(0, limits.readBytes);
      return {
        path: requested,
        // Decoded as UTF-8. A binary file therefore comes back as replacement characters rather
        // than as a base64 blob nothing can read: this tool is for the notes, CSVs and JSON a Bot
        // actually works with, and pretending otherwise would invite it to try images.
        text: slice.toString("utf8"),
        truncated: buffer.byteLength > slice.byteLength,
        bytes: buffer.byteLength,
      };
    },

    /**
     * Open a file as raw bytes for a download.
     *
     * The same `resolvePath` used by text reads enforces the workspace boundary, including symlink
     * resolution. The file is streamed from disk rather than read into a string, so PDFs, images and
     * archives are returned byte-for-byte and the text read limit does not apply.
     */
    async download(requested: string): Promise<{
      path: string;
      name: string;
      bytes: number;
      // A stream from the checked descriptor in confined mode; the file itself otherwise.
      body: Blob | ReadableStream<Uint8Array>;
    }> {
      const full = await resolvePath(requested, false);
      if (confined) return downloadOpened(full, requested);
      const info = await stat(full).catch(() => null);
      if (!info) {
        throw new WorkspaceFileNotFoundError(
          `There is no file at ${requested}.`,
        );
      }
      if (!info.isFile()) {
        throw new WorkspaceFileError(`${requested} is not a file.`);
      }
      if (info.size > limits.downloadBytes) {
        throw new WorkspaceFileTooLargeError(
          `That file is ${info.size} bytes and the download limit is ${limits.downloadBytes}.`,
        );
      }

      return {
        path: requested,
        name: basename(requested.replace(/\\/g, "/")) || "download",
        bytes: info.size,
        // Bun serves this file without reading it into memory, and preserves the byte length a
        // ReadableStream response loses. The caller still receives the raw bytes unchanged.
        body: Bun.file(full),
      };
    },

    /** Write a text file, creating parent directories inside the workspace as needed. */
    async write(
      requested: string,
      contents: string,
      options: { append?: boolean } = {},
    ): Promise<{ path: string; bytes: number; appended: boolean }> {
      if (typeof contents !== "string") {
        throw new WorkspaceFileError("The contents to write must be text.");
      }
      const bytes = Buffer.byteLength(contents, "utf8");
      if (bytes > limits.writeBytes) {
        throw new WorkspaceFileError(
          `That is ${bytes} bytes and the limit is ${limits.writeBytes}.`,
        );
      }

      const full = await resolvePath(requested, true);
      if (confined) {
        await writeOpened(full, requested, contents, options.append === true);
        return { path: requested, bytes, appended: options.append === true };
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents, {
        encoding: "utf8",
        flag: options.append ? "a" : "w",
      });
      return { path: requested, bytes, appended: options.append === true };
    },
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

/** Containment, as a path comparison that cannot be fooled by a shared prefix. */
function assertInside(root: string, candidate: string, shown?: string): void {
  const rel = relative(root, candidate);
  // `relative` returns "" for the root itself, which is inside. It returns something starting with
  // ".." for anything outside, and an absolute path when the two are on different roots. Comparing
  // with startsWith on the raw strings instead would let "/workspace-evil" pass as "/workspace".
  const outside =
    rel !== "" &&
    (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  if (outside) {
    throw new WorkspacePathError(
      `${shown ?? candidate} is outside your workspace, so it cannot be reached.`,
    );
  }
}

/**
 * How many links a chain may pass through before it is treated as a cycle rather than a path.
 *
 * Linux gives up at 40. Anything approaching this is a loop or a deliberate attempt to make the walk
 * expensive, and neither is a file a Bot needs to write.
 */
const MAX_LINK_HOPS = 32;

/**
 * Where a write to `target` would actually put the bytes.
 *
 * Returns `target` unchanged when nothing is there or what is there is not a link, which is every
 * ordinary write. Only a name that is already a symlink walks.
 *
 * Walked with `lstat` and `readlink` rather than resolved with `realpath`, because `realpath` throws
 * on a DANGLING link and `writeFile` creates the file at its destination regardless. A link aimed at
 * a name that does not exist yet would otherwise escape through the failure path rather than the
 * success one, which is the harder version of the bug to notice.
 *
 * Confining rather than forbidding, the same as the read side. A link that points back inside the
 * workspace keeps working: refusing every link would be easier and would break legitimate use.
 */
async function writeDestination(
  target: string,
  shown: string,
): Promise<string> {
  let current = target;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop += 1) {
    const entry = await lstat(current).catch(() => null);
    // Nothing there, or something that is not a link. This is where the write lands.
    if (entry === null || !entry.isSymbolicLink()) return current;
    // A relative link is relative to the directory the link sits in, not to the workspace root.
    current = resolve(dirname(current), await readlink(current));
  }
  throw new WorkspacePathError(
    `${shown} is a chain of links that does not settle, so where a write would land cannot be established.`,
  );
}

/** The closest ancestor of `target` that exists, never above `root`. */
async function nearestExistingAncestor(
  root: string,
  target: string,
): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Ran out of path without finding anything. Only reachable if the root itself vanished.
        throw new WorkspacePathError("The workspace directory is missing.");
      }
      assertInside(root, parent);
      current = parent;
    }
  }
}
