import {
  addApp,
  describeApps,
  removeApp,
  setAppEnabled,
  testApp,
} from "./apps.js";
import {
  createDesktopCard,
  openSettings,
  restartApp,
  wireNotice,
} from "./desktop.js";
// --- app discovery (sub-project 3) ---
import { describeCandidates, toggleCandidate } from "./discover.js";
// --- end app discovery ---
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
  $("desktop").hidden = screen !== "status";
  syncDesktop();
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

/** The 「桌面操作」 card, drawn from the shell's answer. Text only. */
function drawDesktop(described) {
  if ("error" in described) {
    $("desktop-error").textContent = described.error;
    return;
  }
  $("desktop-error").textContent = "";
  $("desktop-title").textContent = described.title;
  $("desktop-rows").replaceChildren(
    ...described.rows.map((item) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = item.label;
      const right = document.createElement("span");
      const state = document.createElement("span");
      state.className = "state";
      state.textContent = item.status;
      state.dataset.tone = item.allowed ? "ok" : "wait";
      right.append(state);
      if (item.action) {
        const { kind } = item.action;
        const open = document.createElement("button");
        open.type = "button";
        open.textContent = item.action.text;
        open.addEventListener("click", async () => {
          const result = await openSettings(kind, invoke);
          if (result.error) $("desktop-error").textContent = result.error;
        });
        right.append(open);
      }
      row.append(label, right);
      return row;
    }),
  );
  $("desktop-note").textContent = described.note ?? "";
  $("desktop-note").hidden = !described.note;
  $("desktop-guide").hidden = !described.guide;
  if (described.guide) {
    $("desktop-guide-image").src = described.guide.image;
    $("desktop-guide-text").textContent = described.guide.text;
  }
  $("desktop-restart").hidden = !described.restart;
  if (described.restart) {
    $("desktop-restart-text").textContent = described.restart.text;
    $("desktop-restart-button").textContent = described.restart.button;
  }
}

const desktop = createDesktopCard({ invoke, draw: drawDesktop });

/** Polled only while the card is on screen: its section shown and the window not hidden. */
function syncDesktop() {
  desktop.setVisible(
    !$("desktop").hidden && document.visibilityState !== "hidden",
  );
}
document.addEventListener("visibilitychange", syncDesktop);

$("desktop-restart-button").addEventListener("click", async () => {
  const result = await restartApp(invoke);
  if (result.error) $("desktop-error").textContent = result.error;
});

/** The runner said a desktop action needs a grant (main.rs `show_desktop`). */
window.showDesktop = () => {
  void desktop.refresh();
  $("desktop").scrollIntoView();
};

for (const details of document.querySelectorAll("#about details")) {
  wireNotice(details, invoke);
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

// --- app discovery (sub-project 3) ---
/** The 发现的应用 list. Names, source labels, a switch and a note: nothing else comes from the runner. */
function renderDiscovered(reply) {
  const described = describeCandidates(reply);
  $("discover-list").replaceChildren(
    ...described.items.map((item) => {
      const row = document.createElement("li");
      row.dataset.disabled = String(item.disabled);
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = item.on;
      box.disabled = item.disabled;
      box.id = `discover-${item.ref}`;
      box.setAttribute("role", "switch");
      const text = document.createElement("label");
      text.className = "text";
      text.htmlFor = box.id;
      const name = document.createElement("strong");
      name.textContent = item.name;
      const source = document.createElement("span");
      source.className = "source";
      source.textContent = item.source;
      text.append(name, source);
      if (item.note) {
        const note = document.createElement("span");
        note.className = "note";
        note.textContent = item.note;
        text.append(note);
      }
      box.addEventListener("change", async () => {
        box.disabled = true;
        $("discover-status").textContent = box.checked
          ? "正在启用并测试，请稍候…"
          : "";
        const result = await toggleCandidate(item, box.checked, invoke);
        $("discover-status").textContent =
          "error" in result ? result.error : result.message;
        // What the runner now says is the truth: redraw both lists from it.
        await refreshDiscovered("keep-status");
        await refreshApps();
      });
      row.append(box, text);
      return row;
    }),
  );
  $("discover-empty").textContent = described.empty ?? "";
}

let lastDiscovered;
let scanSeq = 0;
let scansInFlight = 0;
async function refreshDiscovered(keepStatus) {
  if (!keepStatus) $("discover-status").textContent = "";
  const mine = ++scanSeq;
  scansInFlight += 1;
  $("discover-refresh").disabled = true;
  try {
    const reply = await invoke("discover_apps");
    // A newer scan has been started since: its answer is the one to show.
    if (mine === scanSeq) {
      lastDiscovered = reply;
      renderDiscovered(reply);
    }
  } catch (error) {
    $("discover-status").textContent = String(error);
    // Redraw from the last good answer so no switch stays greyed out.
    if (mine === scanSeq) renderDiscovered(lastDiscovered);
  } finally {
    scansInFlight -= 1;
    if (scansInFlight === 0) $("discover-refresh").disabled = false;
  }
}
$("discover-refresh").addEventListener("click", () => refreshDiscovered());
// --- end app discovery ---

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
  // The keys are write-only: gone from the field whether or not the add worked.
  $("app-env").value = "";
  if ("error" in result) {
    $("app-error").textContent = result.error;
    return;
  }
  $("app-status").textContent = "";
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
// --- app discovery (sub-project 3) ---
// Not awaited: a slow scan must not hold up the status polling below.
refreshDiscovered();
// --- end app discovery ---
setInterval(refresh, 1000);
