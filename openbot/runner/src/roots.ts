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
 * READ ONLY. A root is reached through `createWorkspace`, the same three-layer confinement the
 * workspace uses (no absolute paths, no `..`, no symlink out), and only its `list` and `read` are
 * ever called. Writes, commands and anything else that names a root are refused by the executor
 * before this module is asked (`execute.ts`).
 *
 * NEVER OVER THE RUNNER'S OWN FILES. A root may not be, contain, or sit inside the data directory, the
 * state file or the browser profiles: those hold the device token and the owner's signed-in
 * sessions, and a folder registered over them would hand both to a model. A symlink inside a root
 * that points into them is refused by the confinement like any other link out.
 */

/** What the server is told about a root: never its path. */
export type ReportedRoot = { ref: string; name: string };

/** A root as this machine keeps it. */
export type RegisteredRoot = ReportedRoot & { path: string; addedAt: string };

/** A refusal a person can act on. Chinese, because the device app shows it as it stands. */
export class RootRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootRegistryError";
  }
}

/** The file beside the token that holds the roots. */
export const ROOTS_FILE = "runner-roots.json";
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
  list: () => RegisteredRoot[];
  reported: () => ReportedRoot[];
  add: (name: string, path: string) => RegisteredRoot;
  /** By reference or by name. False when there is nothing by that name to remove. */
  remove: (refOrName: string) => boolean;
  /**
   * The read-only view of one root, or a refusal for a reference this machine does not have.
   *
   * Looked up on every call rather than held: a root removed a moment ago is unknown on the next
   * read, without a restart.
   */
  open: (ref: string) => Pick<Workspace, "list" | "read">;
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

  const list = (): RegisteredRoot[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // No file yet, or one that is not ours: no roots, which is the safe reading of both.
      return [];
    }
    const roots = (parsed as { roots?: unknown })?.roots;
    if (!Array.isArray(roots)) return [];
    return roots.filter(
      (root): root is RegisteredRoot =>
        isRootRef(root?.ref) &&
        typeof root?.name === "string" &&
        typeof root?.path === "string" &&
        isAbsolute(root.path) &&
        typeof root?.addedAt === "string",
    );
  };

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
    reported: () => list().map(({ ref, name }) => ({ ref, name })),

    add(name, path) {
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
      };
      save([...roots, root]);
      return root;
    },

    remove(refOrName) {
      const wanted = refOrName.trim();
      const roots = list();
      // A reference names exactly one root; anything else is a name, compared as `add` compares.
      const byRef = REF.test(wanted);
      const kept = roots.filter((root) =>
        byRef
          ? root.ref !== wanted
          : root.name.toLowerCase() !== wanted.toLowerCase(),
      );
      if (kept.length === roots.length) return false;
      save(kept);
      return true;
    },

    open(ref) {
      const root = isRootRef(ref)
        ? list().find((entry) => entry.ref === ref)
        : undefined;
      if (!root) {
        throw new RootRegistryError(
          "This machine has no folder by that reference. It may have been removed on the machine.",
        );
      }
      // The same confinement and the same per-read limits as the workspace; only the reads exist.
      const workspace = createWorkspace(root.path);
      return { list: workspace.list, read: workspace.read };
    },
  };
}
