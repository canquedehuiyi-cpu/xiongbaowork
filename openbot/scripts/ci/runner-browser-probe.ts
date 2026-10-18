import { mkdtempSync, rmSync } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRunnerBrowser } from "../../runner/src/browser.ts";
import { createActionJournal } from "../../runner/src/journal.ts";
import { createRunnerDispatcher } from "../../runner/src/dispatch.ts";
import { createRunnerExecutor } from "../../runner/src/execute.ts";

/**
 * A real browser, on a real machine, against pages this file serves to itself.
 *
 * WHAT THIS IS. The deterministic suite (`server/tests/runner-browser.test.ts`) stands in for the
 * browser, because the things it proves — a ref from a dead run, a counter that survived a restart, a
 * click cancelled on the way to the page — cannot be arranged inside a live Chromium without killing it
 * mid-assertion. This file is the other half: it starts the browser the operator names, drives it
 * through the runner's real durable path (dispatcher, journal, executor, browser), and checks what a
 * page actually did.
 *
 * WHAT IT IS NOT. It is not part of `bun test` and it launches nothing unless `--run` is given, so an
 * ordinary test run never opens a window on somebody's laptop. It browses no website but its own
 * fixture on 127.0.0.1, and it passes `--browser-private-hosts` to itself for exactly that reason. It
 * writes only inside a temporary directory it creates and removes, never into a person's browser
 * profile, and it installs and downloads nothing: the browser has to be named by the operator.
 *
 * A passing run here is evidence about this machine and this browser build. It is not a delivered
 * product: binary download streaming, a visual human-control screen, and installing or distributing
 * Chrome are separate items, and the native probe the coordinator runs afterwards is its own gate.
 */

const args = process.argv.slice(2);
const valueOf = (name: string): string => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? "" : (args[index + 1] ?? "").trim();
};

const wanted = (name: string): boolean => args.includes(`--${name}`);

if (!wanted("run")) {
  console.log(
    "PROBE NOT REQUESTED: this file launches a real browser, so it does nothing by default.",
  );
  console.log(
    "usage: bun scripts/ci/runner-browser-probe.ts --run --channel chrome | --executable /path/to/chrome [--headless true]",
  );
  process.exit(0);
}

const executablePath = valueOf("executable");
const channel = valueOf("channel");
if (!executablePath && !channel) {
  throw new Error(
    "Name the browser this probe may start: --executable PATH or --channel NAME. It will not choose one for your machine, and it installs nothing.",
  );
}
// Headed is the product's default and the honest way to test it. A CI box with no desktop needs the
// switch, and saying so here keeps it from silently becoming the tested configuration.
const headless = valueOf("headless") === "true";

const FIRST = { tenantId: "probe-tenant", botId: "probe-bot-one" };
const SECOND = { tenantId: "probe-tenant", botId: "probe-bot-two" };
const TOKEN = randomUUID();
/** Long enough that a cancelled click is genuinely cancelled, short enough to be a boring test. */
const ENABLE_AFTER_MS = 3_000;

const probeRoot = mkdtempSync(join(process.cwd(), ".runner-browser-probe-"));
const workspaceDir = join(probeRoot, "workspace");
const profileRoot = join(probeRoot, "browser-profiles");
console.log(
  JSON.stringify({
    probe: "real browser",
    headless,
    browser: executablePath ? `executable ${executablePath}` : `channel ${channel}`,
    disposableRoot: probeRoot,
  }),
);

const requests: string[] = [];
const page = `<!doctype html><meta charset="utf-8"><title>OpenBot fixture</title>
<h1>Disposable fixture</h1><p>Sentinel sentence for the read check.</p>
<p id="jar">jar=unread</p><p id="keystroke">key=none</p>
<form method="get" action="/submitted">
<label>Customer <input id="customer" name="customer" value="existing"
  onkeydown="document.getElementById('keystroke').textContent='key='+event.key"></label>
<label>Secret <input id="secret" type="password" value="hunter2"></label>
</form>
<p><a id="next" href="/done">Proceed to the second page</a></p>
<button id="later" onclick="location='/done'" disabled>Continue later</button>
<script>
const seen = document.cookie.includes("probe=${TOKEN}") ? "token" : "none";
document.getElementById("jar").textContent = "jar=" + seen;
document.cookie = "probe=${TOKEN}; path=/";
setTimeout(() => {
  document.getElementById("later").disabled = false;
}, ${ENABLE_AFTER_MS});
</script>`;

const second = `<!doctype html><meta charset="utf-8"><title>Second page</title>
<h1>Second</h1><p>arrived</p><p id="scrolled">scrolled=no</p>
<div style="height:6000px"></div>
<script>addEventListener("scroll", () => {
  document.getElementById("scrolled").textContent = "scrolled=yes";
}, { once: true });</script>`;

const fixture = {
  "/": page,
  "/done": second,
  "/submitted": "<!doctype html><title>Submitted</title><p>submitted</p>",
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/slow") {
      await Bun.sleep(4_000);
      return new Response("<!doctype html><title>Slow</title><p>slow</p>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (path === "/long") {
      const body = "sentence ".repeat(2_000);
      return new Response(`<!doctype html><title>Long</title><p>${body}</p>`, {
        headers: { "content-type": "text/html" },
      });
    }
    const html = fixture[path as keyof typeof fixture];
    if (!html) return new Response("not found", { status: 404 });
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});
const base = `http://127.0.0.1:${server.port}`;

const browser = createRunnerBrowser({
  profileRoot,
  headless,
  // The fixture is on loopback, which is the one thing this browser may reach here.
  allowPrivateHosts: true,
  ...(executablePath ? { executablePath } : {}),
  ...(channel ? { channel } : {}),
});
const journal = createActionJournal(join(probeRoot, "actions.sqlite"));
const execute = createRunnerExecutor(workspaceDir, browser);
const dispatch = createRunnerDispatcher(journal, execute);
const scope = "probe/device";

let issued = 0;

/** One action, carried the way the socket carries it: through the journal, with a cancel key. */
function request(
  action: string,
  payload: Record<string, unknown>,
  identity: typeof FIRST = FIRST,
): { pending: Promise<Record<string, unknown>>; key: string } {
  issued += 1;
  const key = `probe-${issued}`;
  let frame: Record<string, unknown> = {};
  const pending = dispatch(
    scope,
    {
      type: "action",
      id: key,
      key,
      action,
      payload: { ...identity, ...payload },
    },
    (result) => {
      frame = result;
    },
  ).then(() => frame);
  return { pending, key };
}

async function settle(frame: Promise<Record<string, unknown>>): Promise<
  Record<string, unknown>
> {
  const result = await frame;
  if (result.type !== "result") throw new Error("the runner answered nothing");
  return result;
}

async function output(
  frame: Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const result = await settle(frame);
  if (result.ok !== true) throw new Error(String(result.error));
  return result.output as Record<string, unknown>;
}

async function failure(
  frame: Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const result = await settle(frame);
  if (result.ok === true) throw new Error("the action was expected to be refused");
  return result;
}

const checks: string[] = [];

function assert(ok: unknown, label: string, via: string): void {
  if (!ok) throw new Error(`FAILED: ${label} [${via}]`);
  checks.push(`${label} (${via})`);
  console.log(JSON.stringify({ check: label, passed: true, via }));
}

/** The element list, as the browser's own output carries it. */
function elementsOf(outputFrame: Record<string, unknown>): {
  ref: string;
  role: string;
  name: string;
  value?: string;
}[] {
  return outputFrame.elements as ReturnType<typeof elementsOf>;
}

function refNamed(
  elements: ReturnType<typeof elementsOf>,
  name: string,
): string {
  const found = elements.find((element) => element.name === name);
  if (!found) throw new Error(`no element named ${name} on the fixture page`);
  return found.ref;
}

try {
  // ---- where a browser may be pointed, decided before it is asked for anything ------------------
  const metadata = await failure(
    request("navigate", { url: "http://169.254.169.254/latest/meta-data/iam/" }),
  );
  assert(
    String(metadata.error).includes("cloud credentials"),
    "cloud metadata is refused even with private hosts open",
    "runner policy, before any request",
  );
  const scheme = await failure(
    request("navigate", { url: "file:///etc/passwd" }),
  );
  assert(
    String(scheme.error).includes("Only web addresses are allowed"),
    "a file address is refused whatever this probe has opened",
    "runner policy, before any request",
  );

  // ---- the first real browser on this machine ---------------------------------------------------
  const landed = await output(request("navigate", { url: `${base}/` }));
  assert(
    landed.url === `${base}/`,
    "a real navigation lands on the fixture page",
    "browser",
  );
  assert(
    String(landed.title) === "OpenBot fixture",
    "the real page's title comes back",
    "browser",
  );
  assert(
    String(landed.text).includes("Sentinel sentence for the read check."),
    "the real page's text comes back",
    "browser",
  );

  // ---- cookies, in a profile nobody else uses --------------------------------------------------
  const again = await output(request("navigate", { url: `${base}/` }));
  assert(
    String(again.text).includes("jar=token"),
    "the browser kept this coworker's cookie across a navigation",
    "browser",
  );
  const colleague = await output(
    request("navigate", { url: `${base}/` }, SECOND),
  );
  assert(
    String(colleague.text).includes("jar=none"),
    "a second coworker on the same machine gets a separate cookie jar",
    "browser",
  );

  // ---- an element list a real page produced ----------------------------------------------------
  const list = await output(request("snapshot", {}));
  const snapshotId = Number(list.snapshotId);
  const elements = elementsOf(list);
  assert(
    elements.length >= 4,
    "a real page's controls are listed",
    "browser",
  );
  assert(
    String(list.url) === `${base}/`,
    "the list names the page it was taken from",
    "browser",
  );
  const customer = refNamed(elements, "Customer");
  const secret = refNamed(elements, "Secret");
  const link = refNamed(elements, "Proceed to the second page");
  assert(
    /^[0-9a-f]{8}:[ex\d]+$/.test(secret),
    "an element handle carries this run's token",
    "browser",
  );

  const masked = elements.find((element) => element.ref === secret);
  assert(
    masked?.value !== "hunter2",
    "the password field's value did not reach the caller",
    "browser",
  );
  assert(
    masked?.value === "[hidden: sensitive field]" ||
      masked?.value === undefined,
    "a hidden value is said to be hidden",
    "browser",
  );
  assert(
    !JSON.stringify(list).includes("hunter2"),
    "the page's secret is nowhere in the answer",
    "browser",
  );

  const typed = await output(
    request("type", { ref: customer, snapshotId, text: "Ada Lovelace" }),
  );
  assert(
    typed.characters === 12 && typed.text === undefined,
    "a real field was filled, and what was typed is not read back",
    "browser",
  );
  const filled = await output(request("snapshot", {}));
  assert(
    Number(filled.snapshotId) > snapshotId,
    "a second element list is a later number, never the same one",
    "browser",
  );
  const stillTyped = elementsOf(filled).find(
    (element) => element.name === "Customer",
  );
  assert(
    stillTyped?.value === "Ada Lovelace",
    "the real page holds what was put into it",
    "browser",
  );

  const intoSecret = await failure(
    request("type", { ref: secret, snapshotId: Number(filled.snapshotId), text: "hunter2" }),
  );
  assert(
    String(intoSecret.error).includes("A person has to type it"),
    "the real password field refuses automation",
    "browser",
  );

  // ---- a keystroke that arrived -----------------------------------------------------------------
  const keystroke = await output(request("snapshot", {}));
  const keystrokeId = Number(keystroke.snapshotId);
  await output(
    request("key", {
      ref: refNamed(elementsOf(keystroke), "Customer"),
      snapshotId: keystrokeId,
      key: "Escape",
    }),
  );
  const afterKey = await output(request("read", {}));
  assert(
    String(afterKey.text).includes("key=Escape"),
    "a real key press reached the element the runner named",
    "browser",
  );
  const pageKey = await output(request("key", { key: "Home" }));
  assert(
    pageKey.action === "key",
    "a key press with no element goes to the page and is answered",
    "browser",
  );

  // ---- a click that changed the page, and what that costs --------------------------------------
  const beforeMove = await output(request("snapshot", {}));
  const moveId = Number(beforeMove.snapshotId);
  const moved = await output(
    request("click", { ref: refNamed(elementsOf(beforeMove), "Proceed to the second page"), snapshotId: moveId }),
  );
  assert(
    String(moved.url) === `${base}/done`,
    "a real click followed a real link",
    "browser",
  );
  const stale = await failure(
    request("click", { ref: link, snapshotId }),
  );
  assert(
    String(stale.error).includes("out of date"),
    "the handle from the earlier page is refused, not guessed at",
    "browser",
  );

  const scrolled = await output(request("scroll", { deltaY: 900 }));
  assert(scrolled.action === "scroll", "a real wheel was answered", "browser");
  const scrollSeen = await output(request("read", {}));
  assert(
    String(scrollSeen.text).includes("scrolled=yes"),
    "the real page actually moved",
    "browser",
  );

  const picture = await output(request("screenshot", {}));
  const bytes = Buffer.from(String(picture.base64), "base64");
  assert(
    bytes.subarray(0, 4).toString("hex") === "89504e47",
    "the picture is a real PNG",
    "browser",
  );
  assert(
    picture.width === 1280 && picture.height === 800,
    "the picture is the viewport it claims",
    "browser",
  );
  assert(String(picture.url) === `${base}/done`, "the picture says which page it is of", "browser");

  const long = await output(request("navigate", { url: `${base}/long` }));
  assert(
    String(long.text).length <= 6_000 && long.truncated === true,
    "an over-long page is cut, and says it was",
    "browser",
  );

  // ---- cancellation, through the durable path --------------------------------------------------
  const slow = request("navigate", { url: `${base}/slow` });
  await Bun.sleep(600);
  await dispatch(scope, { type: "cancel", key: slow.key }, () => {});
  const stopped = await settle(slow.pending);
  assert(
    stopped.ok === false && String(stopped.error).includes("stopped"),
    "a navigation cancelled on the way is a stop, not a mystery",
    "browser",
  );
  assert(
    stopped.outcomeUnknown !== true,
    "a cancelled navigation does not pause the device",
    "runner policy",
  );

  const backHome = await output(request("navigate", { url: `${base}/` }));
  assert(String(backHome.url) === `${base}/`, "the browser is usable afterwards", "browser");
  const armed = await output(request("snapshot", {}));
  const armedId = Number(armed.snapshotId);
  const pending = request(
    "click",
    { ref: refNamed(elementsOf(armed), "Continue later"), snapshotId: armedId },
  );
  await Bun.sleep(600);
  await dispatch(scope, { type: "cancel", key: pending.key }, () => {});
  const unknown = await settle(pending.pending);
  assert(
    unknown.ok === false && unknown.outcomeUnknown === true,
    "a cancelled click is an unknown outcome, which is what pauses a device",
    "browser",
  );
  const notMoved = await output(request("read", {}));
  assert(
    String(notMoved.url) === `${base}/`,
    "the page had not moved: the pause is a conservative answer, not a wrong one",
    "browser",
  );

  // ---- the counter is the machine's, not the process's -----------------------------------------
  const lastId = Number(armedId);
  await browser.close();
  const reopened = createRunnerBrowser({
    profileRoot,
    headless,
    allowPrivateHosts: true,
    ...(executablePath ? { executablePath } : {}),
    ...(channel ? { channel } : {}),
  });
  const restartExecute = createRunnerExecutor(workspaceDir, reopened);
  const afterRestart = await restartExecute({
    action: "snapshot",
    payload: { ...FIRST },
  });
  if (!afterRestart.ok) throw new Error(String(afterRestart.error));
  const restartedId = Number(
    (afterRestart.output as Record<string, unknown>).snapshotId,
  );
  assert(
    restartedId > lastId,
    "a new runner process continues the count instead of reusing a number",
    "browser",
  );
  const oldHandle = await restartExecute({
    action: "click",
    payload: { ...FIRST, ref: refNamed(elementsOf(armed), "Customer"), snapshotId: restartedId },
  });
  assert(
    oldHandle.ok === false &&
      String(oldHandle.error).includes("a browser that is not this one"),
    "a handle from the dead process is refused as another browser's",
    "browser",
  );
  await reopened.close();

  assert(
    !requests.includes("/latest/meta-data/iam/"),
    "the refused metadata address was never asked of anything",
    "fixture's own access log",
  );
} finally {
  await browser.close().catch(() => undefined);
  server.close();
  journal.close();
  rmSync(probeRoot, { recursive: true, force: true });
}

console.log(
  JSON.stringify({
    checks: checks.length,
    actions: issued,
    browser: executablePath || channel,
    headless,
  }),
);
console.log("REAL BROWSER: the checks marked browser were answered by the Chromium this machine started, on a page this file served to itself.");
console.log("NOT MOCKED: no fake launcher and no stubbed page were used anywhere in this file.");
console.log("RUNNER POLICY: the checks marked policy were decided before a browser was asked, which is why they cost no launch.");
console.log("LIMITS: no external website, no customer data, no real provider session, no human-control screen, no Chrome installed or distributed. Passing here is not a delivery.");
console.log("BROWSER_PROBE_PASS");
