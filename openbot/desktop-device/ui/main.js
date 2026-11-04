import { describeState, screenFor, submitPairing } from "./pairing.js";

const invoke = window.__TAURI__.core.invoke;
const $ = (id) => document.getElementById(id);

let submitting = false;

function render(view) {
  const screen = submitting ? "pairing" : screenFor(view);
  $("form").hidden = screen !== "form";
  $("waiting").hidden = screen !== "pairing";
  $("status").hidden = screen !== "status";
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

$("restart").addEventListener("click", async () => {
  try {
    await invoke("restart");
  } catch (error) {
    $("state").textContent = String(error);
  }
  await refresh();
});

await refresh();
setInterval(refresh, 1000);
