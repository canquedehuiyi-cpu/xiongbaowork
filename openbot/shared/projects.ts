/**
 * A project's source (story RES2): what the server keeps about where a project's files are, and the
 * static checks every writer of one runs. Shared by the server (before it saves), the runner (before
 * it runs `git`) and the app (to say what is wrong before a request is sent), so the three cannot
 * disagree about what a valid repository address or branch name is.
 *
 * NEVER A PATH, NEVER A CREDENTIAL. A local project names a folder by the opaque reference its runner
 * made (`fld_…`); the absolute path stays on the machine. A Git project names a repository by an
 * address that carries no password and no token: the machine that clones it uses its owner's own
 * SSH keys or credential helper, and the server never connects to the repository at all (decision
 * D4), so it has no use for either.
 *
 * The database checks the same shapes (`resource_projects_source_check`, migration 0136), so no
 * other writer can store a path or a password either.
 */

/** A device's project count is capped (decision D10). */
export const PROJECT_LIMIT_PER_DEVICE = 50;
export const PROJECT_NAME_LIMIT = 80;
export const PROJECT_DESCRIPTION_LIMIT = 500;
export const PROJECT_LABEL_LIMIT = 60;
export const GIT_URL_LIMIT = 500;
export const GIT_BRANCH_LIMIT = 200;

/** The runner's reference shape: `fld_` and 128 random bits in base64url. */
export const ROOT_REF_PATTERN = /^fld_[A-Za-z0-9_-]{22}$/;

export function isRootRef(value: unknown): value is string {
  return typeof value === "string" && ROOT_REF_PATTERN.test(value);
}

export type LocalProjectSource = {
  kind: "local";
  /** The runner's reference for a folder its owner registered on the machine. */
  rootRef: string;
  /** The folder's name as the machine reported it when the project was made. */
  label: string;
  /** Whether files may be written there. Never wider than the folder's mode on the machine (D3). */
  writable: boolean;
};

export type GitProjectSource = {
  kind: "git";
  url: string;
  branch: string;
  /** The runner's reference for its clone, once one exists. Null until the first sync. */
  rootRef: string | null;
  writable: boolean;
  /** When the last sync finished (ISO 8601), or null before the first. */
  syncedAt: string | null;
  /** The commit the clone was at after the last sync, or null before the first. */
  commit: string | null;
};

export type ProjectSource = LocalProjectSource | GitProjectSource;

/** A commit id, SHA-1 or SHA-256, lower-case hex as `git rev-parse` prints it. */
export const COMMIT_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Whitespace, or a control character (below U+0020, or DEL). */
const hasSpaceOrControl = (value: string) =>
  /\s/.test(value) ||
  [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

/**
 * Why a repository address cannot be used, in a sentence for the person, or null when it can.
 *
 * Accepted: `https://host/path` with no user name or password in it, `ssh://[user@]host[:port]/path`
 * with no password, and the scp-like `user@host:path` that `git clone` takes for SSH. Everything else
 * is refused, and in particular:
 *
 *  - `file://`, a bare path, and `ext::…`: a clone of either runs on the machine against the
 *    machine's own disk or runs a command of the address's choosing;
 *  - `http://`: the code would arrive over a connection anybody on the way can change;
 *  - `https://user:token@…` and `ssh://user:password@…`: the credential would be stored here;
 *  - an address starting with `-`, which `git` would read as an option.
 *
 * Private and local host names are not refused: a company's own GitLab on its own network is a fine
 * place for a repository, and it is the person's machine that connects to it, never this server.
 */
export function gitUrlProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "请填写仓库地址。";
  const url = value.trim();
  if (url.length > GIT_URL_LIMIT)
    return `仓库地址最多 ${GIT_URL_LIMIT} 个字符。`;
  if (hasSpaceOrControl(url)) return "仓库地址里不能有空格或控制字符。";
  if (url.startsWith("-")) return "仓库地址不能以 - 开头。";
  if (url.includes("::") || url.includes("[") || url.includes("]"))
    return "不支持这种仓库地址。";
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1];
  if (scheme) {
    const lower = scheme.toLowerCase();
    if (lower !== "https" && lower !== "ssh") {
      return "仓库地址只支持 https:// 或 ssh://（以及 git@主机:路径）。";
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "仓库地址的格式不对。";
    }
    if (!parsed.hostname || parsed.hostname.startsWith("-"))
      return "仓库地址缺少主机名。";
    if (parsed.password) return "仓库地址里不能带密码或令牌。";
    if (lower === "https" && parsed.username) {
      return "仓库地址里不能带用户名或令牌。私有仓库请在设备上配置凭据。";
    }
    // An SSH user name is a name and nothing else: no encoded colon (a password), no leading `-`.
    if (
      parsed.username &&
      !/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(parsed.username)
    )
      return "仓库地址里的用户名不对。";
    if (!parsed.pathname || parsed.pathname === "/")
      return "仓库地址缺少仓库路径。";
    return null;
  }
  // The scp-like form `git clone` reads as SSH: user@host:path, and nothing before the colon is a
  // password. A bare `host:path` is refused with it, because without a user it is easy to misread.
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.+)$/.exec(url);
  if (scp) {
    const [, user, host, path] = scp;
    if (!user || user.startsWith("-") || !host || host.startsWith("-"))
      return "仓库地址的格式不对。";
    if (!path || path.startsWith("-")) return "仓库地址缺少仓库路径。";
    return null;
  }
  return "仓库地址只支持 https:// 或 ssh://（以及 git@主机:路径）。";
}

/**
 * Why a branch name cannot be used, or null when it can.
 *
 * A subset of `git check-ref-format --branch`: letters, digits and `._/-` only, so nothing that a
 * shell, a glob or `git` itself would read as something other than a name can get through, and then
 * the rules `git` adds (no `..`, no `//`, no part starting with `.` or ending in `.lock`, no leading
 * `-` or `/`, no trailing `/` or `.`). The runner passes the name as one argument, never through a
 * shell, and checks it again with this same function before it runs anything.
 */
export function gitBranchProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "请填写分支名。";
  const branch = value.trim();
  if (branch.length > GIT_BRANCH_LIMIT)
    return `分支名最多 ${GIT_BRANCH_LIMIT} 个字符。`;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    return "分支名只能包含字母、数字和 . _ / - 。";
  }
  if (
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch === "@" ||
    branch === "HEAD" ||
    branch
      .split("/")
      .some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) {
    return "这不是一个合法的分支名。";
  }
  return null;
}

/** The source as checked, or the sentence that says what is wrong. */
export type SourceCheck =
  | { ok: true; source: ProjectSource }
  | { ok: false; error: string };

const characters = (value: string) => [...value].length;

/**
 * A source as a person (or a stored row) states it, checked: exactly the fields of one of the two
 * kinds, each of the right type and within its limits. Unknown fields are refused rather than
 * dropped, so a `path` or a `token` someone added is an error and not a silent loss.
 */
export function checkProjectSource(value: unknown): SourceCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, error: "请选择项目来源：本地目录或 Git 仓库。" };
  const body = value as Record<string, unknown>;
  const allowed =
    body.kind === "local"
      ? ["kind", "rootRef", "label", "writable"]
      : body.kind === "git"
        ? ["kind", "url", "branch", "rootRef", "writable", "syncedAt", "commit"]
        : null;
  if (!allowed)
    return { ok: false, error: "请选择项目来源：本地目录或 Git 仓库。" };
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra) return { ok: false, error: `项目来源里有不认识的字段：${extra}` };
  if (typeof body.writable !== "boolean")
    return { ok: false, error: "请说明项目是否可写。" };
  if (body.kind === "local") {
    if (!isRootRef(body.rootRef))
      return { ok: false, error: "请选择设备上已登记的本地目录。" };
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label || characters(label) > PROJECT_LABEL_LIMIT)
      return {
        ok: false,
        error: `目录名称需要 1 到 ${PROJECT_LABEL_LIMIT} 个字。`,
      };
    return {
      ok: true,
      source: {
        kind: "local",
        rootRef: body.rootRef,
        label,
        writable: body.writable,
      },
    };
  }
  const urlProblem = gitUrlProblem(body.url);
  if (urlProblem) return { ok: false, error: urlProblem };
  const branchProblem = gitBranchProblem(body.branch);
  if (branchProblem) return { ok: false, error: branchProblem };
  const rootRef = body.rootRef ?? null;
  if (rootRef !== null && !isRootRef(rootRef))
    return { ok: false, error: "项目的本机副本引用不对。" };
  const syncedAt = body.syncedAt ?? null;
  if (
    syncedAt !== null &&
    (typeof syncedAt !== "string" || Number.isNaN(Date.parse(syncedAt)))
  )
    return { ok: false, error: "同步时间不对。" };
  const commit = body.commit ?? null;
  if (
    commit !== null &&
    (typeof commit !== "string" || !COMMIT_PATTERN.test(commit))
  )
    return { ok: false, error: "commit 不对。" };
  return {
    ok: true,
    source: {
      kind: "git",
      url: String(body.url).trim(),
      branch: String(body.branch).trim(),
      rootRef,
      writable: body.writable,
      syncedAt,
      commit,
    },
  };
}
