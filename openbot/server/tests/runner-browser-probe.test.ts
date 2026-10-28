import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserLauncher, createRunnerBrowser } from "../../runner/src/browser";
import { runnerProbeHandleHasToken } from "../../scripts/ci/runner-browser-probe-ref";
import { stopRunnerProbeServer } from "../../scripts/ci/runner-browser-probe-lifecycle";
import { settleRunnerProbeAction } from "../../scripts/ci/runner-browser-probe-action";
import { createRunnerDispatcher } from "../../runner/src/dispatch";
import { createRunnerExecutor } from "../../runner/src/execute";
import { createActionJournal } from "../../runner/src/journal";

// Fake-page/CLI-gate tests plus an owned loopback ephemeral HTTP fixture.
// No installed browser, external site or real user profile is used.
const roots: string[] = [];
function ownRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openbot-probe-contract-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runner browser probe compatibility", () => {
  test("without --run the actual CLI loads and creates no fixture directory", () => {
    const cwd = ownRoot();
    const entry = fileURLToPath(new URL("../../scripts/ci/runner-browser-probe.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--no-install", entry, "--executable", join(cwd, "browser-must-never-launch")], {
      cwd,
      env: { ...process.env, NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 32768,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("PROBE NOT REQUESTED");
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("accepts handles issued by the actual runner for two fake-page identities", async () => {
    let launches = 0;
    const launch: BrowserLauncher = async () => {
      launches++;
      const page = {
        url: () => "https://probe.invalid/",
        title: async () => "Probe contract",
        isClosed: () => false,
        ariaYaml: async () => '- textbox "Customer" [ref=e1]: sample',
        readableText: async () => "Probe contract",
        navigate: async () => {},
        png: async () => new Uint8Array(),
        viewportSize: () => ({ width: 1280, height: 800 }),
        byRef: () => ({
          count: async () => 1,
          click: async () => {},
          fill: async () => {},
          press: async () => {},
          holdsSecret: async () => false,
        }),
        pressKey: async () => {},
        insertText: async () => {},
        wheel: async () => {},
      };
      return { pages: () => [page], close: async () => {}, onClose: () => {} };
    };
    const browser = createRunnerBrowser({ profileRoot: join(ownRoot(), "profiles"), launch });
    const handles: string[] = [];
    try {
      for (const botId of ["probe-a", "probe-b"]) {
        const raw = await browser.act({ action: "snapshot", identity: { tenantId: "probe-tenant", botId }, payload: {} });
        const snapshot = raw as { snapshotId: number; elements: { ref: string }[] };
        expect(snapshot.snapshotId).toBeGreaterThan(0);
        expect(snapshot.elements).toHaveLength(1);
        const handle = snapshot.elements[0]?.ref ?? "";
        expect(handle.endsWith(":e1")).toBe(true);
        expect(/^[0-9a-f]{8}:[ex\d]+$/.test(handle)).toBe(false);
        expect(runnerProbeHandleHasToken(handle)).toBe(true);
        handles.push(handle);
      }
      expect(launches).toBe(2);
      expect(handles[0]).not.toBe(handles[1]);
    } finally {
      await browser.close();
    }
  });

  test("fixture cleanup closes the actual pinned Bun listener", async () => {
    const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe fixture") });
    const url = fixture.url;
    try {
      expect(await (await fetch(url)).text()).toBe("probe fixture");
      await stopRunnerProbeServer(fixture);
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      await fixture.stop(true);
    }
  });

  test("awaits the real dispatcher result inside its pending/key wrapper before policy checks", async () => {
    const root = ownRoot();
    let launches = 0;
    const browser = createRunnerBrowser({
      profileRoot: join(root, "profiles"),
      launch: async () => { launches++; throw new Error("policy must refuse before browser launch"); },
    });
    const journal = createActionJournal(join(root, "actions.sqlite"));
    const dispatch = createRunnerDispatcher(journal, createRunnerExecutor(join(root, "workspace"), browser));
    try {
      let frame: Record<string, unknown> = {};
      const key = "probe-policy";
      const pending = dispatch("probe/device", {
        type: "action", id: key, key, action: "navigate",
        payload: { tenantId: "probe-tenant", botId: "probe-bot", url: "http://169.254.169.254/latest/meta-data/iam/" },
      }, (value) => { frame = value; }).then(() => frame);
      const result = await settleRunnerProbeAction({ pending, key });
      expect(result.type).toBe("result");
      expect(result.id).toBe(key);
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain("cloud credentials");
      expect(launches).toBe(0);
      expect(await settleRunnerProbeAction(pending)).toEqual(result);
    } finally {
      await browser.close();
      journal.close();
    }
  });

  test("unwrapping still rejects anything other than a result frame", async () => {
    await expect(settleRunnerProbeAction(Promise.resolve({ type: "ack" }))).rejects.toThrow("the runner answered nothing");
    await expect(settleRunnerProbeAction({ key: "missing", pending: Promise.resolve({}) })).rejects.toThrow("the runner answered nothing");
  });

  test("rejects old or malformed token prefixes without changing runner authority", () => {
    for (const value of ["", "01234567:e1", "01234567_89abcdef:e1", "0123456-89abcdef:e1", "01234567-89ABCDEF:e1", "01234567-89abcdef:", "01234567-89abcdef:button"]) {
      expect(runnerProbeHandleHasToken(value)).toBe(false);
    }
  });
});
