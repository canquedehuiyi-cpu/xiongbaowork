import { expect, test } from "bun:test";
import {
  type DesktopSnapshot,
  type DesktopWindow,
  desktopMessage,
} from "../../shared/desktop-control";
import { TOOL_DISABLED } from "../src/approvals/policy";
import {
  type ApprovalCandidate,
  ApprovalRefusedError,
} from "../src/approvals/types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { ComputerTransport } from "../src/computer/client";
import {
  DESKTOP_BACKSTOP_MS,
  DESKTOP_LIST_FAILED,
  DESKTOP_OLD_RUNNER,
  DESKTOP_OWNER_ONLY,
  DESKTOP_UNAVAILABLE_RULE,
  desktopNoGate,
} from "../src/computer/desktop-gateway";
import {
  createDesktopWindowCache,
  desktopCacheKey,
} from "../src/computer/desktop-state";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { createRunnerTransport } from "../src/computer/runner-transport";
import type { DeviceChannel, DispatchTarget } from "../src/devices/channel";
import { runnerAddress } from "../src/devices/channel";
import { createDeviceComputerProvider } from "../src/devices/selection";

/**
 * The server's read-only desktop gateway (device-side desktop viewing, Phase 1): listing a machine's
 * windows and reading one, governed and recorded like every other computer action, on the Bot owner's
 * own machine only. Nothing here clicks, types or launches anything.
 */

const OWNER = "owner";
const ACTOR = { id: OWNER };
const MACHINE = { tenantId: OWNER, deviceId: "dev-1" };
const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const BANK: DesktopWindow = {
  windowId: "w1001-42",
  title: "招商银行 - Google Chrome",
  process: "chrome",
  focused: true,
  minimized: false,
};
const NOTEPAD: DesktopWindow = {
  windowId: "w2002-77",
  title: "笔记.txt - 记事本",
  process: "notepad",
  focused: false,
  minimized: false,
};
const OTHER: DesktopWindow = {
  windowId: "w3003-88",
  title: "计算器",
  process: "calc",
  focused: false,
  minimized: false,
};

type Posted = {
  address: string;
  botId: string;
  path: string;
  payload: unknown;
  timeoutMs: number | undefined;
};

function harness(
  options: {
    windows?: DesktopWindow[][];
    gate?: boolean;
    gateAnswer?: (candidate: ApprovalCandidate) => Promise<undefined>;
    refusal?: string;
    owner?: string;
    failWindows?: Error;
    failSnapshot?: Error;
  } = {},
) {
  const posts: Posted[] = [];
  const candidates: ApprovalCandidate[] = [];
  const early: ApprovalCandidate[] = [];
  const rows: AuditEventInput[] = [];
  const audit: AuditStore = { insert: async (row) => void rows.push(row) };
  const lists = [...(options.windows ?? [[BANK, NOTEPAD]])];
  const transport: ComputerTransport = {
    async post<T>(
      address: string,
      botId: string,
      path: string,
      payload: unknown,
      _caller?: AbortSignal,
      timeoutMs?: number,
    ): Promise<T> {
      posts.push({ address, botId, path, payload, timeoutMs });
      if (path === "/desktop/windows") {
        if (options.failWindows) throw options.failWindows;
        const windows = lists.length > 1 ? lists.shift() : lists[0];
        return { windows: windows ?? [] } as T;
      }
      if (path === "/desktop/snapshot") {
        if (options.failSnapshot) throw options.failSnapshot;
        const { windowId } = payload as { windowId: string };
        const window =
          [BANK, NOTEPAD, OTHER].find((w) => w.windowId === windowId) ?? BANK;
        const snapshot: DesktopSnapshot = {
          snapshotId: "abc123-1",
          window,
          truncated: false,
          elements: [
            {
              ref: "abc123-1:0",
              type: "Document",
              name: "文本编辑器",
              depth: 0,
            },
          ],
        };
        return snapshot as T;
      }
      throw new Error(`unexpected path ${path}`);
    },
    call: async () => {
      throw new Error("no GET expected");
    },
    navigate: async () => {
      throw new Error("no navigation expected");
    },
    download: async () => {
      throw new Error("no download expected");
    },
  };
  const gateway = createComputerGateway({
    provider: createDeviceComputerProvider(),
    auditStore: audit,
    policy: () => PERMISSIVE,
    transport,
    resolveDevice: async () =>
      options.owner === undefined
        ? MACHINE
        : { tenantId: options.owner, deviceId: "dev-1" },
    ...(options.gate === false
      ? {}
      : {
          approvalGate: async (candidate: ApprovalCandidate) => {
            candidates.push(candidate);
            await options.gateAnswer?.(candidate);
            return undefined;
          },
        }),
    approvalRefusal: async (candidate) => {
      early.push(candidate);
      return options.refusal;
    },
  });
  const paths = () => posts.map((post) => post.path);
  const payloads = () =>
    rows.map((row) => row.payload as Record<string, unknown>);
  return { gateway, posts, paths, rows, payloads, candidates, early };
}

test("listing posts desktop/windows to the owner's machine, caches it, and marks titles untrusted", async () => {
  const h = harness();
  const result = await h.gateway.listDesktopWindows("bot-1", ACTOR);
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0]).toMatchObject({
    path: "/desktop/windows",
    address: runnerAddress(MACHINE),
    timeoutMs: DESKTOP_BACKSTOP_MS,
    payload: {},
  });
  expect(result.untrusted).toContain("windows");
  expect(result.windows).toEqual([BANK, NOTEPAD]);
  expect(h.payloads()).toHaveLength(1);
  expect(h.payloads()[0]).toMatchObject({
    action: "computer_desktop_windows",
    decision: { allowed: true },
  });
  // A listing is a read: the gate is asked, with the effect `read`, about the desktop as a whole,
  // never about whatever page the Bot's browser happens to have open.
  expect(h.candidates[0]?.effect).toBe("read");
  expect(h.candidates[0]?.scope).toBe("desktop");
});

test("a malformed window from the device is dropped and never reaches the gate", async () => {
  const malformed = [
    { windowId: "w4004-99", title: 42, process: "evil", focused: false },
    { windowId: "w5005-11", title: "坏进程", process: { x: 1 } },
    { windowId: "not-an-id", title: "伪造", process: "fake" },
    null,
    "w6006-12",
  ] as unknown as DesktopWindow[];
  const h = harness({ windows: [[NOTEPAD, ...malformed]] });
  const listed = await h.gateway.listDesktopWindows("bot-1", ACTOR);
  expect(listed.windows).toEqual([NOTEPAD]);
  const attempt = h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: "w4004-99",
  });
  await expect(attempt).rejects.toThrow(desktopMessage("no_window"));
  // The listing above and the one refetch; never a read of the malformed window.
  expect(h.paths()).toEqual(["/desktop/windows", "/desktop/windows"]);
  expect(
    h.candidates.filter((c) => c.toolRef === "computer_desktop_snapshot"),
  ).toHaveLength(0);
  expect(h.candidates.every((c) => !String(c.scope).includes("evil"))).toBe(
    true,
  );
});

test("a snapshot of a listed window uses the cached title: one listing, one read", async () => {
  const h = harness();
  await h.gateway.listDesktopWindows("bot-1", ACTOR);
  const result = await h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: NOTEPAD.windowId,
  });
  expect(h.paths()).toEqual(["/desktop/windows", "/desktop/snapshot"]);
  expect(h.posts[1]).toMatchObject({
    address: runnerAddress(MACHINE),
    timeoutMs: DESKTOP_BACKSTOP_MS,
  });
  expect(result.untrusted).toContain("window");
  expect(result.untrusted).toContain("elements");
  expect(result.window.title).toBe(NOTEPAD.title);
});

test("a cache miss lists again once; a window still missing is refused and never read", async () => {
  const h = harness({ windows: [[BANK]] });
  const attempt = h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: OTHER.windowId,
  });
  await expect(attempt).rejects.toBeInstanceOf(ActionRefusedError);
  await expect(attempt).rejects.toThrow(desktopMessage("no_window"));
  expect(h.paths()).toEqual(["/desktop/windows"]);
  expect(h.payloads()).toHaveLength(1);
  expect(h.payloads()[0]).toMatchObject({
    action: "computer_desktop_snapshot",
    refusal: desktopMessage("no_window"),
    decision: { allowed: false, rule: DESKTOP_UNAVAILABLE_RULE },
  });
});

test("a failed relist on a cache miss is refused and audited once as desktop.unavailable", async () => {
  const h = harness({ failWindows: new Error("device offline") });
  const attempt = h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: OTHER.windowId,
  });
  await expect(attempt).rejects.toBeInstanceOf(ActionRefusedError);
  await expect(attempt).rejects.toThrow(DESKTOP_LIST_FAILED);
  expect(h.payloads()).toHaveLength(1);
  expect(h.payloads()[0]).toMatchObject({
    action: "computer_desktop_snapshot",
    refusal: DESKTOP_LIST_FAILED,
    decision: { allowed: false, rule: DESKTOP_UNAVAILABLE_RULE },
  });
});

test("a Stop during the relist is not turned into a refusal", async () => {
  const stop = new Error("aborted");
  const controller = new AbortController();
  controller.abort();
  const h = harness({ failWindows: stop });
  await expect(
    h.gateway.snapshotDesktop(
      "bot-1",
      ACTOR,
      { windowId: OTHER.windowId },
      controller.signal,
    ),
  ).rejects.toBe(stop);
  expect(h.rows).toHaveLength(0);
});

test("an old runner's answer is the Chinese update hint, for the list and the snapshot", async () => {
  const old = new Error('Nothing on this machine handles "desktop.windows".');
  const list = harness({ failWindows: old });
  await expect(list.gateway.listDesktopWindows("bot-1", ACTOR)).rejects.toThrow(
    DESKTOP_OLD_RUNNER,
  );
  expect(JSON.stringify(list.rows)).not.toContain("Nothing on this machine");
  const read = harness({ failSnapshot: old });
  await read.gateway.listDesktopWindows("bot-1", ACTOR);
  await expect(
    read.gateway.snapshotDesktop("bot-1", ACTOR, { windowId: BANK.windowId }),
  ).rejects.toThrow(DESKTOP_OLD_RUNNER);
  expect(JSON.stringify(read.rows)).not.toContain("Nothing on this machine");
  // A relist that finds the old runner says so, not the generic failure.
  const miss = harness({ failWindows: old });
  await expect(
    miss.gateway.snapshotDesktop("bot-1", ACTOR, { windowId: OTHER.windowId }),
  ).rejects.toThrow(DESKTOP_OLD_RUNNER);
});

test("a cache miss that the second listing finds is read", async () => {
  const h = harness({ windows: [[BANK], [BANK, OTHER]] });
  await h.gateway.listDesktopWindows("bot-1", ACTOR);
  await h.gateway.snapshotDesktop("bot-1", ACTOR, { windowId: OTHER.windowId });
  expect(h.paths()).toEqual([
    "/desktop/windows",
    "/desktop/windows",
    "/desktop/snapshot",
  ]);
});

test("a sensitive title reaches the gate with subject.desktop and the frame allows it", async () => {
  const h = harness();
  await h.gateway.listDesktopWindows("bot-1", ACTOR);
  await h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: BANK.windowId,
    screenshot: true,
  });
  const candidate = h.candidates.find(
    (c) => c.toolRef === "computer_desktop_snapshot",
  );
  expect(candidate?.subject?.desktop).toEqual({
    title: "招商银行 - Google Chrome",
    sensitiveWord: "银行",
  });
  expect(candidate?.scope).toBe("desktop/chrome");
  expect(candidate?.effect).toBe("read");
  expect(candidate?.target).toEqual({
    window: { title: "招商银行 - Google Chrome", process: "chrome" },
    screenshot: true,
  });
  const read = h.posts.find((post) => post.path === "/desktop/snapshot");
  expect(read?.payload).toEqual({
    windowId: BANK.windowId,
    screenshot: true,
    allowSensitive: true,
  });
});

test("a plain title sends allowSensitive false", async () => {
  const h = harness();
  await h.gateway.listDesktopWindows("bot-1", ACTOR);
  await h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: NOTEPAD.windowId,
    from: "abc123-1:4",
  });
  const read = h.posts.find((post) => post.path === "/desktop/snapshot");
  expect(read?.payload).toEqual({
    windowId: NOTEPAD.windowId,
    from: "abc123-1:4",
    allowSensitive: false,
  });
  const candidate = h.candidates.find(
    (c) => c.toolRef === "computer_desktop_snapshot",
  );
  expect(candidate?.subject?.desktop).toEqual({ title: NOTEPAD.title });
});

test("rows carry the window's title and process, never its elements", async () => {
  const h = harness();
  await h.gateway.listDesktopWindows("bot-1", ACTOR);
  await h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: NOTEPAD.windowId,
  });
  const row = h
    .payloads()
    .find((p) => p.action === "computer_desktop_snapshot");
  expect(row?.desktop).toEqual({
    windowId: NOTEPAD.windowId,
    title: NOTEPAD.title,
    process: NOTEPAD.process,
    screenshot: false,
  });
  expect(row?.device).toBe("dev-1");
  expect(JSON.stringify(h.rows)).not.toContain("文本编辑器");
});

test("a sensitive window is refused when there is no approval gate", async () => {
  const h = harness({ gate: false });
  await h.gateway.listDesktopWindows("bot-1", ACTOR);
  const attempt = h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: BANK.windowId,
  });
  await expect(attempt).rejects.toBeInstanceOf(ActionRefusedError);
  await expect(attempt).rejects.toThrow(desktopNoGate("银行"));
  expect(h.paths()).toEqual(["/desktop/windows"]);
  expect(
    h.payloads().find((p) => p.action === "computer_desktop_snapshot"),
  ).toMatchObject({
    refusal: desktopNoGate("银行"),
    decision: { allowed: false, rule: DESKTOP_UNAVAILABLE_RULE },
  });
  // A plain title is still read without a gate.
  await h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: NOTEPAD.windowId,
  });
  expect(h.paths()).toEqual(["/desktop/windows", "/desktop/snapshot"]);
});

test("only the Bot's owner: anyone else is refused and nothing is sent", async () => {
  const h = harness({ owner: "someone-else" });
  const listing = h.gateway.listDesktopWindows("bot-1", ACTOR);
  await expect(listing).rejects.toBeInstanceOf(ActionRefusedError);
  await expect(listing).rejects.toThrow(DESKTOP_OWNER_ONLY);
  const read = h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: BANK.windowId,
  });
  await expect(read).rejects.toThrow(DESKTOP_OWNER_ONLY);
  expect(h.posts).toHaveLength(0);
  expect(h.candidates).toHaveLength(0);
});

test("a disabled tool is refused before the device is asked anything", async () => {
  const h = harness({ refusal: TOOL_DISABLED });
  const attempt = h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: BANK.windowId,
  });
  await expect(attempt).rejects.toThrow(TOOL_DISABLED);
  expect(h.posts).toHaveLength(0);
  expect(h.early[0]).toMatchObject({
    toolRef: "computer_desktop_snapshot",
    effect: "read",
    scope: "desktop",
    subject: { runner: true },
  });
  expect(h.payloads()).toHaveLength(1);
  expect(h.payloads()[0]).toMatchObject({
    action: "computer_desktop_snapshot",
    refusal: TOOL_DISABLED,
    decision: { allowed: false },
  });
});

test("a malformed windowId or from is refused before any frame", async () => {
  const h = harness();
  const badWindow = h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: "notepad",
  });
  await expect(badWindow).rejects.toBeInstanceOf(ActionRefusedError);
  await expect(badWindow).rejects.toThrow(desktopMessage("no_window"));
  const badRef = h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: BANK.windowId,
    from: "e12",
  });
  await expect(badRef).rejects.toThrow(desktopMessage("stale"));
  expect(h.posts).toHaveLength(0);
  expect(h.early).toHaveLength(0);
  expect(h.payloads()).toHaveLength(2);
  expect(
    h
      .payloads()
      .every(
        (p) =>
          (p.decision as { allowed: boolean; rule: string }).allowed ===
            false &&
          (p.decision as { rule: string }).rule === DESKTOP_UNAVAILABLE_RULE,
      ),
  ).toBeTrue();
});

test("a refusal from the gate (deny) never sends the read", async () => {
  const h = harness({
    gateAnswer: async (candidate) => {
      if (candidate.toolRef === "computer_desktop_snapshot")
        throw new ApprovalRefusedError("主人拒绝了。");
      return undefined;
    },
  });
  await h.gateway.listDesktopWindows("bot-1", ACTOR);
  const attempt = h.gateway.snapshotDesktop("bot-1", ACTOR, {
    windowId: BANK.windowId,
  });
  await expect(attempt).rejects.toBeInstanceOf(ApprovalRefusedError);
  expect(h.paths()).toEqual(["/desktop/windows"]);
  // The decision row and the failure row; neither names the window's contents.
  const rows = h
    .payloads()
    .filter((p) => p.action === "computer_desktop_snapshot");
  expect(rows).toHaveLength(2);
  expect(rows[1]?.failure).toBe("主人拒绝了。");
  expect(rows[1]?.desktop).toMatchObject({ title: BANK.title });
});

test("the window cache replaces a whole listing, ages entries out, and keeps a bounded number of keys", () => {
  let clock = 0;
  const cache = createDesktopWindowCache({
    now: () => clock,
    ttlMs: 100,
    limit: 2,
  });
  const key = desktopCacheKey(MACHINE, "bot-1");
  expect(key).toBe("owner/dev-1/bot-1");
  cache.remember(key, [BANK, NOTEPAD]);
  expect(cache.find(key, NOTEPAD.windowId)).toEqual(NOTEPAD);
  cache.remember(key, [BANK]);
  expect(cache.find(key, NOTEPAD.windowId)).toBeUndefined();
  clock = 101;
  expect(cache.find(key, BANK.windowId)).toBeUndefined();
  cache.remember("a", [BANK]);
  cache.remember("b", [BANK]);
  cache.remember("c", [BANK]);
  expect(cache.find("a", BANK.windowId)).toBeUndefined();
  expect(cache.find("b", BANK.windowId)).toEqual(BANK);
  expect(cache.find("c", BANK.windowId)).toEqual(BANK);
});

test("the runner transport maps desktop/* to desktop.* and never queues them", async () => {
  const dispatched: {
    target: DispatchTarget;
    action: string;
    payload: unknown;
    timeoutMs?: number;
    mode?: { durable?: boolean };
  }[] = [];
  const channel = {
    isReachable: () => true,
    dispatch: async <T>(
      target: DispatchTarget,
      action: string,
      payload: unknown,
      timeoutMs?: number,
      _key?: string,
      _caller?: AbortSignal,
      mode?: { durable?: boolean },
    ): Promise<T> => {
      dispatched.push({
        target,
        action,
        payload,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(mode ? { mode } : {}),
      });
      return {} as T;
    },
  } as unknown as DeviceChannel;
  const transport = createRunnerTransport(channel);
  await transport.post(
    runnerAddress(MACHINE),
    "bot-1",
    "/desktop/snapshot",
    { windowId: BANK.windowId, allowSensitive: false },
    undefined,
    DESKTOP_BACKSTOP_MS,
  );
  await transport.post(runnerAddress(MACHINE), "bot-1", "/desktop/windows", {});
  expect(dispatched[0]?.action).toBe("desktop.snapshot");
  expect(dispatched[0]?.mode).toEqual({ durable: false });
  expect(dispatched[0]?.timeoutMs).toBe(DESKTOP_BACKSTOP_MS);
  expect(dispatched[0]?.payload).not.toHaveProperty("tenantId");
  expect(dispatched[0]?.payload).not.toHaveProperty("botId");
  expect(dispatched[1]?.action).toBe("desktop.windows");
  expect(dispatched[1]?.mode).toEqual({ durable: false });
});
