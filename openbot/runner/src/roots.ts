import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createWorkspace,
  type Workspace,
} from "../../agent-computer/src/workspace";

/**
 * Folders the owner of this machine lets their 分身 read, and nothing else (story F1, stage 2, S2).
 *
 * A ROOT IS REGISTERED HERE, ON THIS MACHINE, AND NOWHERE ELSE. The owner names a folder with a
 * command they type (`--add-root`) or a field in the device app's window; nothing the server sends can
 * add one. Each gets an opaque reference (`fld_…`, random) and a display name the owner chose. The
 * reference and the name are what the server is told (`reported()`, carried on the heartbeat); the
 * absolute path stays in `runner-roots.json` beside the token, because a folder's path names the
 * person, their clients and their projects, and the server has no use for any of that.
 *
 * READ ONLY UNLESS ITS OWNER SAID OTHERWISE. A root is reached through `createWorkspace`, the same
 * three-layer confinement the workspace uses (no absolute paths, no `..`, no symlink out). A folder is
 * registered `read` unless the owner registered it `write` (story RES2, decision D3: a project they
 * let coworkers change, chosen here on the machine with `--root-mode write`, never by the server).
 * A `read` root is only ever listed and read; its `write` is never handed out, and the executor
 * refuses writes, commands and anything else that names one before this module is asked
 * (`execute.ts`). A `write` root is written to only when the server's own frame also says the project
 * is writable, so the server can make a folder stricter and never wider.
 *
 * A GIT PROJECT'S CLONE IS A ROOT TOO (story RES2, §3.3). The runner clones it into
 * `<dataDir>/runner-projects/<ref>/`, beside the workspace and never inside it, and registers it here
 * with `origin: "git"` and mode `write`, because it is this machine's own copy rather than a folder
 * of the owner's. A clone is not one of the owner's folders: it is not reported on the heartbeat, not
 * listed by `--list-roots`, not counted against the folder limit, and not removed by name.
 *
 * NEVER OVER THE RUNNER'S OWN FILES. A root may not be, contain, or sit inside the data directory, the
 * state file or the browser profiles: those hold the device token and the owner's signed-in
 * sessions, and a folder registered over them would hand both to a model. A symlink inside a root
 * that points into them is refused by the confinement like any other link out.
 */

/** Whether a root may be written to. `read` unless its owner registered it otherwise (D3). */
export type RootMode = "read" | "write";

/**
 * What the server is told about a root: never its path. The mode is said only when it is `write`, so
 * every folder F1 offers is reported exactly as before.
 */
export type ReportedRoot = { ref: string; name: string; mode?: "write" };

/** A root as this machine keeps it. */
export type RegisteredRoot = {
  ref: string;
  name: string;
  path: string;
  addedAt: string;
  /** Absent is `read`. */
  mode?: "write";
  /** Absent is one of the owner's folders; `git` is a project clone this runner made. */
  origin?: "git";
};

/** One root, opened: the workspace's confinement over its folder, and what may be done there. */
export type OpenRoot = Pick<Workspace, "list" | "read"> & {
  mode: RootMode;
  /** The folder on this machine. Used to run a command there; never sent anywhere. */
  path: string;
  /** Only on a `write` root. */
  write?: Workspace["write"];
};

/** A refusal a person can act on. Chinese, because the device app shows it as it stands. */
export class RootRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootRegistryError";
  }
}

/** The file beside the token that holds the roots. */
export const ROOTS_FILE = "runner-roots.json";
/** Where project clones live, beside the workspace and never inside it. */
export const PROJECTS_DIR = "runner-projects";
/** A machine holds at most this many projects (decision D10), so at most this many clones. */
export const MAX_CLONES = 50;
/** Enough for a person's working folders, few enough to carry on every heartbeat. */
export const MAX_ROOTS = 20;
/** Characters (code points), the same ceiling as an information source's name on the server. */
export const ROOT_NAME_LIMIT = 60;
/** `fld_` and 22 base64url characters: 128 random bits. The server checks the same shape. */
const REF = /^fld_[A-Za-z0-9_-]{22}$/;

export function isRootRef(value: unknown): value is string {
  return typeof value === "string" && REF.test(value);
}

function mintRef(): string {
  return `fld_${randomBytes(16).toString("base64url")}`;
}

/** Inside or equal, as a path comparison that a shared prefix cannot fool. */
function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A path as it really is on disk, or as given when it does not exist yet. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export type RootRegistry = {
  readonly file: string;
  /** The owner's folders. */
  list: () => RegisteredRoot[];
  reported: () => ReportedRoot[];
  add: (name: string, path: string, mode?: RootMode) => RegisteredRoot;
  /** The folder a clone with this reference lives in, whether or not it exists yet. */
  clonePath: (ref: string) => string;
  /** A clone this runner already made, by reference, or undefined. */
  clone: (ref: string) => RegisteredRoot | undefined;
  /** The reference a new clone will use. */
  mintCloneRef: () => string;
  /**
   * Register a clone this runner just made in `clonePath(ref)`. The path is always that one, never
   * a folder a caller chose, so a frame from the server cannot register a folder of its choosing.
   */
  registerClone: (ref: string, name: string) => RegisteredRoot;
  /** By reference or by name. False when there is nothing by that name to remove. */
  remove: (refOrName: string) => boolean;
  /**
   * The read-only view of one root, or a refusal for a reference this machine does not have.
   *
   * Looked up on every call rather than held: a root removed a moment ago is unknown on the next
   * read, without a restart.
   */
  open: (ref: string) => OpenRoot;
};

/**
 * The registry kept in `<dataDir>/runner-roots.json`.
 *
 * `privatePaths` are the runner's own files (state file, journal, workspace, browser profiles, and
 * the whole data directory when one was asked for): no root may be, contain, or sit inside any of
 * them. The registry's own file is always one of them.
 */
export function createRootRegistry(options: {
  dataDir: string;
  privatePaths?: readonly string[];
}): RootRegistry {
  const file = join(options.dataDir, ROOTS_FILE);
  const privatePaths = [file, ...(options.privatePaths ?? [])].map(real);
  const projectsDir = join(options.dataDir, PROJECTS_DIR);
  const clonePath = (ref: string) => join(projectsDir, ref);

  /** Every root, the owner's folders and this runner's clones. */
  const all = (): RegisteredRoot[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // No file yet, or one that is not ours: no roots, which is the safe reading of both.
      return [];
    }
    const roots = (parsed as { roots?: unknown })?.roots;
    if (!Array.isArray(roots)) return [];
    return roots
      .filter(
        (root): root is RegisteredRoot =>
          isRootRef(root?.ref) &&
          typeof root?.name === "string" &&
          typeof root?.path === "string" &&
          isAbsolute(root.path) &&
          typeof root?.addedAt === "string" &&
          // A clone is only ever the folder this runner made for it, whatever the file says.
          (root?.origin !== "git" || root.path === clonePath(root.ref)),
      )
      .map(({ ref, name, path, addedAt, mode, origin }) => ({
        ref,
        name,
        path,
        addedAt,
        ...(mode === "write" ? { mode } : {}),
        ...(origin === "git" ? { origin } : {}),
      }));
  };
  const list = () => all().filter((root) => root.origin !== "git");

  /** Written whole, to a temporary file renamed over the old one, and private like the token. */
  const save = (roots: RegisteredRoot[]) => {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ roots }, null, 2)}\n`, {
      mode: 0o600,
    });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // A filesystem without modes still got a file it created private.
    }
    renameSync(temporary, file);
  };

  return {
    file,
    list,
    reported: () =>
      list().map(({ ref, name, mode }) =>
        mode === "write" ? { ref, name, mode } : { ref, name },
      ),
    clonePath,
    clone: (ref) =>
      isRootRef(ref)
        ? all().find((root) => root.origin === "git" && root.ref === ref)
        : undefined,
    mintCloneRef: () => mintRef(),

    registerClone(ref, name) {
      if (!isRootRef(ref)) throw new RootRegistryError("项目引用不对。");
      const roots = all();
      const existing = roots.find((root) => root.ref === ref);
      if (existing) {
        if (existing.origin !== "git")
          throw new RootRegistryError("这个引用已经属于一个本地文件夹。");
        return existing;
      }
      if (roots.filter((root) => root.origin === "git").length >= MAX_CLONES)
        throw new RootRegistryError(`每台设备最多 ${MAX_CLONES} 个项目副本。`);
      const shown = [...name.trim()].slice(0, ROOT_NAME_LIMIT).join("") || ref;
      const root: RegisteredRoot = {
        ref,
        name: shown,
        path: clonePath(ref),
        addedAt: new Date().toISOString(),
        mode: "write",
        origin: "git",
      };
      save([...roots, root]);
      return root;
    },

    add(name, path, mode = "read") {
      if (mode !== "read" && mode !== "write")
        throw new RootRegistryError(
          "文件夹的权限只能是只读（read）或读写（write）。",
        );
      const shown = name.trim();
      if (!shown) throw new RootRegistryError("请给这个文件夹起个名字。");
      if ([...shown].length > ROOT_NAME_LIMIT) {
        throw new RootRegistryError(`名称最多 ${ROOT_NAME_LIMIT} 个字。`);
      }
      const asked = path.trim();
      if (!asked) throw new RootRegistryError("请填写文件夹的路径。");
      if (!isAbsolute(asked)) {
        throw new RootRegistryError("请填写文件夹的完整路径（绝对路径）。");
      }
      let folder: string;
      try {
        folder = realpathSync(asked);
      } catch {
        throw new RootRegistryError("找不到这个文件夹。");
      }
      if (!statSync(folder).isDirectory()) {
        throw new RootRegistryError("这是一个文件，不是文件夹。");
      }
      if (
        privatePaths.some((own) => within(folder, own) || within(own, folder))
      ) {
        throw new RootRegistryError(
          "这个文件夹包含或位于设备端自己的数据目录（里面有设备令牌和浏览器登录状态），不能添加。",
        );
      }
      const roots = list();
      if (within(projectsDir, folder) || within(folder, projectsDir)) {
        throw new RootRegistryError(
          "这个文件夹包含或位于设备端自己的数据目录（里面有设备令牌和浏览器登录状态），不能添加。",
        );
      }
      if (roots.length >= MAX_ROOTS) {
        throw new RootRegistryError(`最多添加 ${MAX_ROOTS} 个本地文件夹。`);
      }
      const sameName = roots.find(
        (root) => root.name.toLowerCase() === shown.toLowerCase(),
      );
      if (sameName) {
        throw new RootRegistryError(
          `已经有一个叫「${sameName.name}」的文件夹了。`,
        );
      }
      const samePath = roots.find((root) => root.path === folder);
      if (samePath) {
        throw new RootRegistryError(
          `这个文件夹已经以「${samePath.name}」添加过了。`,
        );
      }
      const root: RegisteredRoot = {
        ref: mintRef(),
        name: shown,
        path: folder,
        addedAt: new Date().toISOString(),
        ...(mode === "write" ? { mode } : {}),
      };
      save([...all(), root]);
      return root;
    },

    remove(refOrName) {
      const wanted = refOrName.trim();
      const roots = all();
      // A reference names exactly one root; anything else is a name, compared as `add` compares, and
      // a name only ever names one of the owner's folders, never a clone.
      const byRef = REF.test(wanted);
      const kept = roots.filter((root) =>
        byRef
          ? root.ref !== wanted
          : root.origin === "git" ||
            root.name.toLowerCase() !== wanted.toLowerCase(),
      );
      if (kept.length === roots.length) return false;
      save(kept);
      return true;
    },

    open(ref) {
      const root = isRootRef(ref)
        ? all().find((entry) => entry.ref === ref)
        : undefined;
      if (!root) {
        throw new RootRegistryError(
          "This machine has no folder by that reference. It may have been removed on the machine.",
        );
      }
      // The same confinement and the same per-read limits as the workspace. A `read` root has no
      // `write` at all, so no caller can reach one by mistake.
      const workspace = createWorkspace(root.path);
      return root.mode === "write"
        ? {
            list: workspace.list,
            read: workspace.read,
            write: workspace.write,
            mode: "write",
            path: root.path,
          }
        : {
            list: workspace.list,
            read: workspace.read,
            mode: "read",
            path: root.path,
          };
    },
  };
}
