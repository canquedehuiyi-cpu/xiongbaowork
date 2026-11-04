import { addFolder, describeFolders, removeFolder } from "./folders.js";
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

$("folder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("folder-error").textContent = "";
  const result = await addFolder(
    { name: $("folder-name").value, path: $("folder-path").value },
    invoke,
  );
  if ("error" in result) {
    $("folder-error").textContent = result.error;
    return;
  }
  $("folder-name").value = "";
  $("folder-path").value = "";
  renderFolders(result.roots);
});

/** The tray's 「添加本地文件夹…」 opens the window here (main.rs `show_folders`). */
window.showFolders = () => {
  void refreshFolders();
  $("folders").scrollIntoView();
  $("folder-name").focus();
};

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
setInterval(refresh, 1000);
