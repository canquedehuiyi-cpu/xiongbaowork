/**
 * The 本地文件夹 section's rules, with nothing that needs a window, so `tests/folders.test.ts` can
 * check them under Bun. `main.js` wires them to the page.
 *
 * A folder added here is one the person's 分身 may read and never write (story F1, stage 2). It is
 * registered read only unless the person at this computer ticks 「允许员工修改此文件夹中的文件」, which
 * registers it `write`: a project's coworkers may then change it, when the project is also set writable
 * on the server, which can only make it stricter (story RES2, decision D3). The runner keeps the list
 * on this computer; the server is told each folder's name and an opaque reference, never where it is.
 * The Rust side (`src-tauri/src/roots.rs`) checks the same things again (and that the mode is one of
 * the two), and the runner a third time, with the rules that matter most (no folder over its own
 * files).
 */

/** Shown under the write box while it is ticked. */
export const WRITE_WARNING =
  "勾选后，员工可以在这个文件夹里修改、删除文件和运行命令（项目在熊宝里也设为可写时）。请只对有备份或用 Git 管理的文件夹开启。";

/**
 * The runner's mode for the window's write box: `write` only when it is ticked, `read` otherwise.
 *
 * @param {boolean | undefined} write
 * @returns {"read" | "write"}
 */
export function modeFor(write) {
  return write === true ? "write" : "read";
}

/**
 * How the list names a folder's mode. Anything but `write` (including the runner leaving it out) is
 * shown as read only, which is what the runner treats it as.
 *
 * @param {string | undefined} mode
 */
export function modeLabel(mode) {
  return mode === "write" ? "可写" : "只读";
}

/**
 * Whether a path is absolute, on either system this app runs on.
 *
 * @param {string} path
 */
export function isAbsolutePath(path) {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}

/**
 * @param {{ name: string, path: string, write?: boolean }} form
 * @returns {{ ok: true, value: { name: string, path: string, mode: "read" | "write" } } | { ok: false, field: "name" | "path", error: string }}
 */
export function validateFolder(form) {
  const name = form.name.trim();
  if (!name)
    return { ok: false, field: "name", error: "请给这个文件夹起个名字。" };
  if ([...name].length > 60) {
    return { ok: false, field: "name", error: "名称最多 60 个字。" };
  }
  if (name.includes("=")) {
    return { ok: false, field: "name", error: "名称里不能有「=」。" };
  }
  const path = form.path.trim();
  if (!path) return { ok: false, field: "path", error: "请填写文件夹的路径。" };
  if (!isAbsolutePath(path)) {
    return {
      ok: false,
      field: "path",
      error: "请填写文件夹的完整路径（绝对路径）。",
    };
  }
  return { ok: true, value: { name, path, mode: modeFor(form.write) } };
}

/**
 * Add a folder: check it, then hand it to the shell. Resolves to the folders after the change, or
 * to the sentence to show under the form.
 *
 * @param {{ name: string, path: string, write?: boolean }} form
 * @param {(command: string, args?: Record<string, unknown>) => Promise<unknown>} invoke
 * @returns {Promise<{ roots: Array<{ ref: string, name: string, path: string, mode?: string }> } | { error: string }>}
 */
export async function addFolder(form, invoke) {
  const checked = validateFolder(form);
  if (!checked.ok) return { error: checked.error };
  try {
    const roots =
      /** @type {Array<{ ref: string, name: string, path: string, mode?: string }>} */ (
        await invoke("add_root", checked.value)
      );
    return { roots };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * Stop offering a folder.
 *
 * @param {string} reference
 * @param {(command: string, args?: Record<string, unknown>) => Promise<unknown>} invoke
 */
export async function removeFolder(reference, invoke) {
  try {
    const roots =
      /** @type {Array<{ ref: string, name: string, path: string, mode?: string }>} */ (
        await invoke("remove_root", { reference })
      );
    return { roots };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * What the list shows: each folder's name, where it is on this computer, and whether it is read only
 * or writable. The path is shown here, to the person at this computer; it is not what the server is
 * told. The runner cannot change a folder's mode in place, so changing it is removing the folder and
 * adding it again.
 *
 * @param {Array<{ ref: string, name: string, path: string, mode?: string }>} roots
 */
export function describeFolders(roots) {
  if (roots.length === 0) {
    return { empty: "还没有添加本地文件夹。", items: [] };
  }
  return {
    empty: null,
    items: roots.map((root) => ({
      ref: root.ref,
      name: root.name,
      path: root.path,
      mode: modeLabel(root.mode),
      writable: root.mode === "write",
      remove: `移除 ${root.name}`,
    })),
  };
}
