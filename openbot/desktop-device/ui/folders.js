/**
 * The 本地文件夹 section's rules, with nothing that needs a window, so `tests/folders.test.ts` can
 * check them under Bun. `main.js` wires them to the page.
 *
 * A folder added here is one the person's 分身 may read and never write (story F1, stage 2). The
 * runner keeps the list on this computer; the server is told each folder's name and an opaque
 * reference, never where it is. The Rust side (`src-tauri/src/roots.rs`) checks the same things again,
 * and the runner a third time, with the rules that matter most (no folder over its own files).
 */

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
 * @param {{ name: string, path: string }} form
 * @returns {{ ok: true, value: { name: string, path: string } } | { ok: false, field: "name" | "path", error: string }}
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
  return { ok: true, value: { name, path } };
}

/**
 * Add a folder: check it, then hand it to the shell. Resolves to the folders after the change, or
 * to the sentence to show under the form.
 *
 * @param {{ name: string, path: string }} form
 * @param {(command: string, args?: Record<string, unknown>) => Promise<unknown>} invoke
 * @returns {Promise<{ roots: Array<{ ref: string, name: string, path: string }> } | { error: string }>}
 */
export async function addFolder(form, invoke) {
  const checked = validateFolder(form);
  if (!checked.ok) return { error: checked.error };
  try {
    const roots =
      /** @type {Array<{ ref: string, name: string, path: string }>} */ (
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
      /** @type {Array<{ ref: string, name: string, path: string }>} */ (
        await invoke("remove_root", { reference })
      );
    return { roots };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * What the list shows: each folder's name and where it is on this computer. The path is shown here,
 * to the person at this computer; it is not what the server is told.
 *
 * @param {Array<{ ref: string, name: string, path: string }>} roots
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
      remove: `移除 ${root.name}`,
    })),
  };
}
