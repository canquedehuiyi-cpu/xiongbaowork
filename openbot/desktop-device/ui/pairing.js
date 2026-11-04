/**
 * The pairing form's rules and the words for each state, with nothing that needs a window, so
 * `tests/pairing.test.ts` can check them under Bun. `main.js` wires them to the page.
 *
 * The Rust side checks the same things again (`src-tauri/src/sidecar.rs`): this copy is here so a
 * mistake is pointed out next to the field, before anything is started.
 */

/**
 * @param {string} input
 * @returns {{ server: string, error?: undefined } | { error: string, server?: undefined }}
 */
export function normalizeServer(input) {
  const match = input.trim().match(/^(https?:\/\/)(.*)$/);
  if (!match) return { error: "服务器地址需要以 https:// 或 http:// 开头。" };
  const rest = match[2].replace(/\/+$/, "");
  if (!rest || /\s/.test(rest)) return { error: "服务器地址不完整。" };
  return { server: match[1] + rest };
}

/**
 * @param {{ server: string, code: string, name: string }} form
 * @returns {{ ok: true, value: { server: string, code: string, name: string } } | { ok: false, field: "server" | "code" | "name", error: string }}
 */
export function validatePairing(form) {
  const server = normalizeServer(form.server);
  if (server.error !== undefined) {
    return { ok: false, field: "server", error: server.error };
  }
  const code = form.code.trim();
  if (!code) return { ok: false, field: "code", error: "请输入配对码。" };
  if (code.length > 64 || /\s/.test(code)) {
    return { ok: false, field: "code", error: "配对码格式不正确。" };
  }
  const name = form.name.trim();
  if ([...name].length > 120) {
    return { ok: false, field: "name", error: "设备名称不能超过 120 个字符。" };
  }
  return { ok: true, value: { server: server.server, code, name } };
}

/**
 * What the window shows for the state `status` returns.
 *
 * @param {{ state: string, attempt?: number, inSeconds?: number, message?: string }} state
 * @returns {{ text: string, tone: "ok" | "wait" | "bad" | "idle" }}
 */
export function describeState(state) {
  switch (state.state) {
    case "online":
      return { text: "在线", tone: "ok" };
    case "pairing":
      return { text: "正在配对…", tone: "wait" };
    case "starting":
      return { text: "正在连接…", tone: "wait" };
    case "offline":
      return { text: "离线，正在重连", tone: "wait" };
    case "restarting":
      return {
        text: `设备端服务已退出，${state.inSeconds} 秒后第 ${state.attempt} 次重启`,
        tone: "wait",
      };
    case "failed":
      return { text: `出错：${state.message}`, tone: "bad" };
    case "stopped":
      return { text: "已停止", tone: "idle" };
    default:
      return { text: "未配对", tone: "idle" };
  }
}

/**
 * Which part of the window to show: the form until a pairing has worked, the status after.
 *
 * @param {{ paired: boolean, state: { state: string } }} view
 */
export function screenFor(view) {
  if (view.paired) return "status";
  return view.state.state === "pairing" ? "pairing" : "form";
}

/**
 * Submit the form: check it, then hand it to the shell. Resolves to the message to show under the
 * form, or null when the pairing run has started.
 *
 * @param {{ server: string, code: string, name: string }} form
 * @param {(command: string, args?: Record<string, unknown>) => Promise<unknown>} invoke
 */
export async function submitPairing(form, invoke) {
  const checked = validatePairing(form);
  if (!checked.ok) return checked.error;
  try {
    await invoke("pair", checked.value);
    return null;
  } catch (error) {
    return String(error);
  }
}
