import {
  addApp,
  describeApps,
  removeApp,
  setAppEnabled,
  testApp,
} from "./apps.js";
import {
  addFolder,
  describeFolders,
  removeFolder,
  WRITE_WARNING,
} from "./folders.js";
import { describeState, screenFor, submitPairing } from "./pairing.js";

const invoke = window.__TAURI__.core.invoke;
const $ = (id) => document.getElementById(id);

let submitting = false;

function render(view) {
  const screen = submitting ? "pairing" : screenFor(view);
  $("form").hidden = screen !== "form";
  $("waiting").hidden = screen !== "pairing";
  $("status").hidden = screen !== "status";
  // The folders are this computer's, offered once it is paired to somebody's 分身.
  $("folders").hidden = screen !== "status";
  $("apps").hidden = screen !== "status";
  $("browser").hidden = !view.browserMissing;

  if (screen === "form" && view.state.state === "failed") {
    $("form-error").textContent = view.state.message;
  }
  const described = describeState(view.state);
  $("state").textContent = described.text;
  $("state").dataset.tone = described.tone;
  $("server").textContent = view.server ?? "";
  $("name").textContent = view.name ?? "（使用本机名称）";
  $("autostart").textContent = view.autostart ? "已开启" : "未开启";
  $("restart").hidden = !["failed", "stopped"].includes(view.state.state);
  $("log").textContent = view.log;
}

async function refresh() {
  try {
    render(await invoke("status"));
  } catch (error) {
    $("form-error").textContent = String(error);
  }
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("form-error").textContent = "";
  submitting = true;
  const message = await submitPairing(
    {
      server: $("server-input").value,
      code: $("code-input").value,
      name: $("name-input").value,
    },
    invoke,
  );
  submitting = false;
  if (message) $("form-error").textContent = message;
  await refresh();
});

/** The folder list, drawn from what the runner printed. Text only: a path is never markup. */
function renderFolders(roots) {
  const described = describeFolders(roots);
  const list = $("folder-list");
  list.replaceChildren(
    ...described.items.map((item) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = item.name;
      const mode = document.createElement("span");
      mode.className = "mode";
      mode.textContent = item.mode;
      mode.dataset.writable = String(item.writable);
      label.append(mode);
      const path = document.createElement("span");
      path.className = "path";
      path.textContent = item.path;
      label.append(path);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", item.remove);
      remove.addEventListener("click", async () => {
        const result = await removeFolder(item.ref, invoke);
        if ("error" in result) $("folder-error").textContent = result.error;
        else renderFolders(result.roots);
      });
      row.append(label, remove);
      return row;
    }),
  );
  $("folder-empty").textContent = described.empty ?? "";
}

async function refreshFolders() {
  try {
    renderFolders(await invoke("list_roots"));
  } catch (error) {
    $("folder-error").textContent = String(error);
  }
}

/** The warning is shown only while the write box is ticked; unticked (read only) is the default. */
function renderWriteWarning() {
  const ticked = $("folder-write").checked;
  $("folder-write-warning").textContent = ticked ? WRITE_WARNING : "";
  $("folder-write-warning").hidden = !ticked;
}
$("folder-write").addEventListener("change", renderWriteWarning);

$("folder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("folder-error").textContent = "";
  const result = await addFolder(
    {
      name: $("folder-name").value,
      path: $("folder-path").value,
      write: $("folder-write").checked,
    },
    invoke,
  );
  if ("error" in result) {
    $("folder-error").textContent = result.error;
    return;
  }
  $("folder-name").value = "";
  $("folder-path").value = "";
  // Back to read only after each add, so the next folder is not made writable by accident.
  $("folder-write").checked = false;
  renderWriteWarning();
  renderFolders(result.roots);
});

/** The tray's 「添加本地文件夹…」 opens the window here (main.rs `show_folders`). */
window.showFolders = () => {
  void refreshFolders();
  $("folders").scrollIntoView();
  $("folder-name").focus();
};

/** The app list, drawn from what the runner printed (env values already masked). Text only. */
function renderApps(apps) {
  const described = describeApps(apps);
  $("app-list").replaceChildren(
    ...described.items.map((item) => {
      const row = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = `${item.name}（${item.kind}，${item.status}）`;
      row.append(title);
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = item.detail;
      row.append(detail);
      for (const line of item.env) {
        const env = document.createElement("span");
        env.className = "env";
        env.textContent = line;
        row.append(env);
      }
      const actions = document.createElement("div");
      actions.className = "actions";
      const button = (text, label, onClick, danger = false) => {
        const el = document.createElement("button");
        el.type = "button";
        el.textContent = text;
        el.setAttribute("aria-label", label);
        if (danger) el.className = "danger";
        el.addEventListener("click", onClick);
        return el;
      };
      const show = (result) => {
        if ("error" in result) $("app-status").textContent = result.error;
        else if ("apps" in result) {
          $("app-status").textContent = "";
          renderApps(result.apps);
        } else $("app-status").textContent = result.message;
      };
      actions.append(
        button("测试连接", `测试 ${item.name}`, async () => {
          $("app-status").textContent = "正在测试，请稍候…";
          show(await testApp(item.ref, invoke));
        }),
        button(item.toggle, `${item.toggle} ${item.name}`, async () => {
          show(await setAppEnabled(item.ref, !item.enabled, invoke));
        }),
        button(
          "删除",
          item.remove,
          async () => show(await removeApp(item.ref, invoke)),
          true,
        ),
      );
      row.append(actions);
      return row;
    }),
  );
  $("app-empty").textContent = described.empty ?? "";
}

async function refreshApps() {
  try {
    renderApps(await invoke("list_apps"));
  } catch (error) {
    $("app-error").textContent = String(error);
  }
}

function renderAppKind() {
  const stdio = $("app-kind").value === "stdio";
  $("app-stdio-fields").hidden = !stdio;
  $("app-http-fields").hidden = stdio;
}
$("app-kind").addEventListener("change", renderAppKind);

$("app-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("app-error").textContent = "";
  const stdio = $("app-kind").value === "stdio";
  const result = await addApp(
    stdio
      ? {
          kind: "stdio",
          name: $("app-name").value,
          command: $("app-command").value,
          args: $("app-args").value,
          env: $("app-env").value,
          cwd: $("app-cwd").value,
        }
      : { kind: "http", name: $("app-name").value, url: $("app-url").value },
    invoke,
  );
  if ("error" in result) {
    $("app-error").textContent = result.error;
    return;
  }
  for (const id of ["app-name", "app-command", "app-args", "app-env", "app-cwd", "app-url"]) {
    $(id).value = "";
  }
  renderApps(result.apps);
});

$("restart").addEventListener("click", async () => {
  try {
    await invoke("restart");
  } catch (error) {
    $("state").textContent = String(error);
  }
  await refresh();
});

await refresh();
await refreshFolders();
await refreshApps();
setInterval(refresh, 1000);
