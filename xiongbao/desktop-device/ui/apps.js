/**
 * The 本机应用（MCP） section's rules, with nothing that needs a window, so `tests/apps.test.ts` can
 * check them under Bun. `main.js` wires them to the page.
 *
 * An app added here is a local MCP server the person's 员工 may call through this computer. The command,
 * arguments and keys stay in the runner's `runner-apps.json` on this computer; the server is told each
 * app's name and an opaque reference only. The runner keeps the rules that matter (duplicate names,
 * the loopback-only url) and prints environment values masked, so a key is never shown back here.
 * `src-tauri/src/apps.rs` runs the runner once per command.
 */

/** What an environment value is shown as, on this screen and in the runner's own output. */
export const MASK = "••••";

/** The same hosts the runner accepts (runner/src/apps.ts): this computer, over http or https. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * One argument per line; blank lines are dropped, spaces inside a line are kept.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseArgsLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * One `KEY=VALUE` per line, split at the first `=`; both sides are trimmed.
 *
 * @param {string} text
 * @returns {{ ok: true, env: Record<string, string> } | { ok: false, error: string }}
 */
export function parseEnvLines(text) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf("=");
    const key = at < 0 ? "" : line.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return {
        ok: false,
        error: "环境变量每行写成 名称=值，名称只能用字母、数字和下划线。",
      };
    }
    env[key] = line.slice(at + 1).trim();
  }
  return { ok: true, env };
}

/**
 * An environment value as shown: always the mask, whatever it is.
 *
 * @param {string} _value
 */
export function maskEnv(_value) {
  return MASK;
}

/**
 * @param {string} text
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validateUrl(text) {
  const value = text.trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: URL_ERROR };
  }
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTS.has(url.hostname)
  ) {
    return { ok: true, value };
  }
  return { ok: false, error: URL_ERROR };
}

const URL_ERROR =
  "网址只能填本机地址（127.0.0.1、localhost 或 [::1]，以 http:// 或 https:// 开头）。";

/** @param {string} raw */
function checkName(raw) {
  const name = raw.trim();
  if (!name) return { error: "请给这个应用起个名字。" };
  if ([...name].length > 60) return { error: "名称最多 60 个字。" };
  return { name };
}

/**
 * @param {{ name: string, command: string, args: string, env: string, cwd: string }} form
 * @returns {{ ok: true, value: { name: string, kind: "stdio", command: string, args: string[], env: Record<string, string>, cwd?: string } } | { ok: false, field: string, error: string }}
 */
export function validateStdio(form) {
  const named = checkName(form.name);
  if (named.error) return { ok: false, field: "name", error: named.error };
  const command = form.command.trim();
  if (!command) {
    return { ok: false, field: "command", error: "请填写启动应用的命令。" };
  }
  const env = parseEnvLines(form.env);
  if (!env.ok) return { ok: false, field: "env", error: env.error };
  const cwd = form.cwd.trim();
  return {
    ok: true,
    value: {
      name: /** @type {string} */ (named.name),
      kind: "stdio",
      command,
      args: parseArgsLines(form.args),
      env: env.env,
      ...(cwd ? { cwd } : {}),
    },
  };
}

/**
 * @param {{ name: string, url: string }} form
 * @returns {{ ok: true, value: { name: string, kind: "http", url: string } } | { ok: false, field: string, error: string }}
 */
export function validateHttp(form) {
  const named = checkName(form.name);
  if (named.error) return { ok: false, field: "name", error: named.error };
  const url = validateUrl(form.url);
  if (!url.ok) return { ok: false, field: "url", error: url.error };
  return {
    ok: true,
    value: {
      name: /** @type {string} */ (named.name),
      kind: "http",
      url: url.value,
    },
  };
}

/** @typedef {(command: string, args?: Record<string, unknown>) => Promise<unknown>} Invoke */
/** @typedef {{ ref: string, name: string, kind: string, enabled: boolean, command?: string, args?: string[], env?: Record<string, string>, url?: string }} AppRow */

/**
 * Add an app: check the form, then hand it to the shell. Resolves to the apps after the change, or
 * to the sentence to show under the form.
 *
 * @param {{ kind: "stdio", name: string, command: string, args: string, env: string, cwd: string } | { kind: "http", name: string, url: string }} form
 * @param {Invoke} invoke
 * @returns {Promise<{ apps: AppRow[] } | { error: string }>}
 */
export async function addApp(form, invoke) {
  const checked =
    form.kind === "stdio" ? validateStdio(form) : validateHttp(form);
  if (!checked.ok) return { error: checked.error };
  try {
    return {
      apps: /** @type {AppRow[]} */ (
        await invoke("add_app", { definition: checked.value })
      ),
    };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * @param {string} target
 * @param {Invoke} invoke
 */
export async function removeApp(target, invoke) {
  try {
    return {
      apps: /** @type {AppRow[]} */ (await invoke("remove_app", { target })),
    };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * @param {string} target
 * @param {boolean} enabled
 * @param {Invoke} invoke
 */
export async function setAppEnabled(target, enabled, invoke) {
  try {
    return {
      apps: /** @type {AppRow[]} */ (
        await invoke("set_app_enabled", { target, enabled })
      ),
    };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * Start the app once and list its tools, to say whether it can be reached.
 *
 * @param {string} target
 * @param {Invoke} invoke
 * @returns {Promise<{ message: string } | { error: string }>}
 */
export async function testApp(target, invoke) {
  try {
    const reply = /** @type {{ count: number, tools: string[] }} */ (
      await invoke("test_app", { target })
    );
    const tools = (reply.tools ?? []).length
      ? `：${(reply.tools ?? []).join("、")}`
      : "";
    return { message: `连接成功，找到 ${reply.count} 个工具${tools}` };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * What the list shows. Environment values are the runner's masked ones, passed through `maskEnv`
 * again so nothing else can reach the screen.
 *
 * @param {AppRow[]} apps
 */
export function describeApps(apps) {
  if (apps.length === 0) {
    return { empty: "还没有添加本机应用。", items: [] };
  }
  return {
    empty: null,
    items: apps.map((app) => ({
      ref: app.ref,
      name: app.name,
      kind: app.kind === "http" ? "本机地址" : "启动命令",
      detail:
        app.kind === "http"
          ? (app.url ?? "")
          : [app.command ?? "", ...(app.args ?? [])].join(" ").trim(),
      env: Object.entries(app.env ?? {}).map(
        ([key, value]) => `${key}=${maskEnv(value)}`,
      ),
      enabled: app.enabled,
      status: app.enabled ? "已启用" : "已停用",
      toggle: app.enabled ? "停用" : "启用",
      remove: `删除 ${app.name}`,
    })),
  };
}
