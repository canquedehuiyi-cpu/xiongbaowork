import { describe, expect, test } from "bun:test";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import {
  DEFAULT_DESKTOP_ACTION_WORDS,
  type DesktopElement,
  type DesktopSnapshot,
  type DesktopWindow,
  desktopMessage,
} from "../../shared/desktop-control";
import { desktopActionReason } from "../src/approvals/desktop-policy";
import { decideAction, refusedOutright } from "../src/approvals/policy";
import { oneRowPerAction } from "../../shared/activity-rows";
import { isApprovedExecution } from "../src/approvals/service";
import {
  type ApprovalCandidate,
  type ApprovalContinuation,
  type ApprovalPolicyOutcome,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalStore,
  type ApprovalSubject,
  approvalAction,
  withApprovalContext,
} from "../src/approvals/types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  type ComputerTransport,
  ComputerUnavailableError,
} from "../src/computer/client";
import {
  DESKTOP_OWNER_ONLY,
  NO_DESKTOP,
  desktopOwnersMachine,
} from "../src/computer/desktop-gateway";
import {
  createDesktopSessionCache,
  desktopSessionKey,
} from "../src/computer/desktop-session";
import { createDesktopControlCache } from "../src/computer/desktop-state";
import {
  createDesktopWriteGate,
  DESKTOP_SESSION_UNAPPROVED,
  DESKTOP_STOPPED_REASON,
  DESKTOP_TEXT_TOO_LONG,
  type DesktopWriteGovern,
} from "../src/computer/desktop-write";
import {
  ActionRefusedError,
  createComputerGateway,
  intentOf,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { DeviceActionError, runnerAddress } from "../src/devices/channel";
import { createDeviceComputerProvider } from "../src/devices/selection";
import { runnerMessageOptions } from "../src/http-server";
import { runAsTenant } from "../src/tenant/context";
import {
  approvalFixtureModel,
  createApprovalFixtureService,
} from "./helpers/approval-producer-model";

/**
 * The desktop writes on the server (plan Task 22): click, type, key and focus through the session
 * gate, each decided by the per-action floors from what this server read (never the model's words),
 * recorded with the length of what was typed and never the text itself, and sent to the device with
 * the team's action words and the title the owner saw.
 */

const OWNER = "owner";
const ACTOR = { id: OWNER };
const MACHINE = { tenantId: OWNER, deviceId: "dev-1" };
const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const HEX64 = /[0-9a-f]{64}/;

const NOTEPAD: DesktopWindow = {
  windowId: "a0123456789abcdef",
  title: "笔记.txt - 记事本",
  process: "notepad",
  focused: true,
  minimized: false,
};
const WECHAT: DesktopWindow = {
  windowId: "afedcba9876543210",
  title: "微信",
  process: "wechat",
  focused: false,
  minimized: false,
};
const ELEMENTS: Record<string, DesktopElement[]> = {
  [NOTEPAD.windowId]: [
    { ref: "abc123-1:0", type: "textarea", name: "正文", depth: 0 },
    { ref: "abc123-1:1", type: "button", name: "确定", depth: 1 },
    {
      ref: "abc123-1:2",
      type: "textfield",
      name: "搜索",
      depth: 1,
      singleLine: true,
    },
    {
      ref: "abc123-1:3",
      type: "textfield",
      name: "密码",
      depth: 1,
      password: true,
    },
    { ref: "abc123-1:4", type: "button", name: "  ", depth: 1 },
  ],
  [WECHAT.windowId]: [
    { ref: "abc123-2:0", type: "button", name: "发送", depth: 0 },
    { ref: "abc123-2:1", type: "button", name: "归档", depth: 0 },
  ],
};

type Posted = { path: string; payload: Record<string, unknown> };
type Card = { candidate: ApprovalCandidate; outcome: ApprovalPolicyOutcome };

const CONTINUATION = (args: unknown): ApprovalContinuation => ({
  runId: "run-1",
  threadId: "thread-1",
  toolCallId: "call-1",
  toolName: "computer_desktop_type",
  args,
  messages: [],
  state: {},
  context: [],
  forwardedProps: {},
});

/**
 * The real gateway over a fake device. The device keeps one session (none until `session_start`);
 * its write answers come from `write`. The approval gate decides with the real policy: an ask is
 * recorded as a card and approved at once (a permit), an allow lets the write through unasked.
 */
function harness(
  options: {
    owner?: string;
    session?: boolean;
    windows?: DesktopWindow[];
    write?: (
      path: string,
      payload: Record<string, unknown>,
      call: number,
    ) => unknown;
    words?: () => Promise<readonly string[] | null | undefined>;
    /** What the gate answers instead of deciding: "allow" lets every write through unasked. */
    gate?: "allow" | ((candidate: ApprovalCandidate) => Promise<unknown>);
    refusal?: (candidate: ApprovalCandidate) => string | undefined;
    teamWords?: string[];
    /** What the device lists as its windows now (default: `windows`, or notepad and WeChat). */
    windowsList?: () => DesktopWindow[];
    /** The gateway's clock: its window and control lists age by it. */
    now?: () => number;
    /** Rows the audit store fails to write (thrown), after keeping nothing. */
    auditFails?: (row: AuditEventInput) => boolean;
  } = {},
) {
  const posts: Posted[] = [];
  const cards: Card[] = [];
  const gated: ApprovalCandidate[] = [];
  const early: ApprovalCandidate[] = [];
  const rows: AuditEventInput[] = [];
  const audit: AuditStore = {
    insert: async (row) => {
      if (options.auditFails?.(row)) throw new Error("the audit store is down");
      rows.push(row);
    },
  };
  let token: string | undefined = options.session ? "ab".repeat(32) : undefined;
  let writes = 0;
  const transport: ComputerTransport = {
    async post<T>(
      address: string,
      botId: string,
      path: string,
      payload: unknown,
    ): Promise<T> {
      expect(address).toBe(runnerAddress(MACHINE));
      expect(botId).toBe("bot");
      const body = (payload ?? {}) as Record<string, unknown>;
      posts.push({ path, payload: body });
      if (path === "/desktop/windows")
        return {
          windows: options.windowsList?.() ??
            options.windows ?? [NOTEPAD, WECHAT],
        } as T;
      if (path === "/desktop/snapshot") {
        const window =
          [NOTEPAD, WECHAT].find((w) => w.windowId === body.windowId) ??
          NOTEPAD;
        const snapshot: DesktopSnapshot = {
          snapshotId:
            window.windowId === NOTEPAD.windowId ? "abc123-1" : "abc123-2",
          window,
          truncated: false,
          elements: ELEMENTS[window.windowId] ?? [],
        };
        return snapshot as T;
      }
      if (path === "/desktop/session_status")
        return {
          writable: true,
          platform: "macos",
          ...(token ? { session: { token } } : {}),
        } as T;
      if (path === "/desktop/session_start") {
        token = String(body.token);
        return { started: true } as T;
      }
      writes += 1;
      if (options.write) return options.write(path, body, writes) as T;
      return {
        physical: false,
        durationMs: 12,
        delivery: "verified",
        window: {
          windowId: NOTEPAD.windowId,
          title: NOTEPAD.title,
          process: "notepad",
        },
        note: "The window may have changed: read it again before the next step.",
      } as T;
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
    ...(options.now ? { now: options.now } : {}),
    resolveDevice: async () =>
      options.owner === undefined
        ? MACHINE
        : { tenantId: options.owner, deviceId: "dev-1" },
    ...(options.words ? { desktopActionWords: options.words } : {}),
    approvalGate: async (candidate: ApprovalCandidate) => {
      gated.push(candidate);
      if (options.gate === "allow") return undefined;
      if (options.gate) return (await options.gate(candidate)) as never;
      const outcome = await decideAction({
        team: [],
        personal: [],
        customRulesEnabled: true,
        autoReview: false,
        askBeforeChanges: true,
        candidate,
        ...(options.teamWords ? { desktopActionWords: options.teamWords } : {}),
      });
      if (outcome.behaviour === "deny")
        throw new ApprovalRefusedError(outcome.reason);
      if (outcome.behaviour === "allow") return undefined;
      cards.push({ candidate, outcome });
      return { complete: async () => undefined };
    },
    approvalRefusal: async (candidate) => {
      early.push(candidate);
      return options.refusal?.(candidate);
    },
  });
  const paths = () => posts.map((post) => post.path);
  const writesPosted = () =>
    posts.filter((post) =>
      /^\/desktop\/(click|type|key|focus)$/.test(post.path),
    );
  const payloads = () =>
    rows.map((row) => row.payload as Record<string, unknown>);
  const read = (windowId = NOTEPAD.windowId) =>
    gateway.snapshotDesktop("bot", ACTOR, { windowId });
  return {
    gateway,
    posts,
    paths,
    writesPosted,
    cards,
    gated,
    early,
    rows,
    payloads,
    read,
    token: () => token,
    /** The owner stopped the session on the device, or it expired there. */
    endSession: () => {
      token = undefined;
    },
  };
}

/** An approval service over an in-memory store whose one request starts pending (see approval-fresh-producer.test.ts). */
function approvalFixture() {
  const rows = new Map<string, ApprovalRecord>();
  const store: ApprovalStore = {
    enabled: async () => true,
    setEnabled: async () => {},
    open: async (value) => {
      const row: ApprovalRecord = {
        id: "approval",
        ownerUserId: value.actorId,
        action: structuredClone(value),
        status: "pending",
        decision: null,
        result: null,
        createdAt: new Date(0),
        decidedAt: null,
        consumedAt: null,
        completedAt: null,
      } as unknown as ApprovalRecord;
      if (!rows.has(row.id)) rows.set(row.id, row);
      return structuredClone(rows.get(row.id) as ApprovalRecord);
    },
    get: async (_owner, id) => structuredClone(rows.get(id) as ApprovalRecord),
    list: async () => [...rows.values()],
    decide: async (_owner, id) =>
      structuredClone(rows.get(id) as ApprovalRecord),
    consume: async (_owner, id, digest) => {
      const row = rows.get(id) as ApprovalRecord;
      if (row.action.actionDigest !== digest || row.status !== "approved")
        return false;
      row.status = "consumed";
      return true;
    },
    saveResult: async (_owner, id, result) => {
      const row = rows.get(id) as ApprovalRecord;
      if (row.result) return false;
      row.result = structuredClone(result);
      return true;
    },
    finish: async (_owner, id) => {
      (rows.get(id) as ApprovalRecord).status = "completed";
    },
    rules: async () => [],
    revoke: async () => {},
  } as ApprovalStore;
  const service = createApprovalFixtureService(store);
  approvalFixtureModel(store);
  return { rows, store, service };
}

/** The pending request approved, then carried out by the server as the resume sweep does. */
async function approveAndResume(
  fixture: ReturnType<typeof approvalFixture>,
  tool: () => Promise<unknown>,
) {
  const row = fixture.rows.get("approval") as ApprovalRecord;
  row.status = "approved";
  await fixture.service.resume(OWNER, "approval", {
    validate: (action: ApprovalRecord["action"]) =>
      fixture.service.validateReentry(action, tool),
    execute: () => tool(),
    continue: async () => {},
  } as never);
  return fixture.rows.get("approval") as ApprovalRecord;
}

const lastWrite = (h: ReturnType<typeof harness>) =>
  h.writesPosted().at(-1)?.payload as Record<string, unknown>;

describe("desktop writes through the gateway", () => {
  test("a click on a control read in a snapshot reaches the gate with its window and control", async () => {
    const h = harness();
    await h.read();
    const result = await h.gateway.clickDesktop("bot", ACTOR, {
      ref: "abc123-1:1",
    });
    expect(result).toEqual({
      ok: true,
      physical: false,
      delivery: "verified",
      window: {
        windowId: NOTEPAD.windowId,
        title: NOTEPAD.title,
        process: "notepad",
      },
      note: "The window may have changed: read it again before the next step.",
    });
    // One card, the session's, deciding on the window and control this server read.
    expect(h.cards).toHaveLength(1);
    const asked = h.cards[0]?.candidate as ApprovalCandidate;
    expect(asked.toolRef).toBe("computer_desktop_click");
    expect(asked.effect).toBe("write");
    expect(asked.scope).toBe("desktop/notepad");
    expect(asked.subject?.runner).toBe(true);
    expect(asked.subject?.desktopWrite).toEqual({
      session: "none",
      action: "click",
      title: NOTEPAD.title,
      process: "notepad",
      control: { type: "button", name: "确定" },
    });
    expect(h.cards[0]?.outcome.source).toBe("desktop_session");
    expect(h.paths().slice(-3)).toEqual([
      "/desktop/session_status",
      "/desktop/session_start",
      "/desktop/click",
    ]);
    expect(lastWrite(h)).toEqual({
      session: h.token(),
      botId: "bot",
      actorId: OWNER,
      approved: true,
      actionWords: [...DEFAULT_DESKTOP_ACTION_WORDS],
      approvedTitle: NOTEPAD.title,
      ref: "abc123-1:1",
    });
    // Recorded through the gateway's own `govern`: the attempt row names the window and control.
    const attempt = h
      .payloads()
      .find((row) => row.action === "computer_desktop_click");
    expect(attempt?.desktop).toEqual({
      windowId: NOTEPAD.windowId,
      title: NOTEPAD.title,
      process: "notepad",
      control: { type: "button", name: "确定" },
      action: "click",
    });
    expect(attempt?.ref).toBeNull();
    expect(intentOf("computer_desktop_click", undefined)).toBe("write");
  });

  test("a ref this replica never saw asks as 控件不明", async () => {
    const h = harness({ session: true });
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-9:1" });
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]?.candidate.subject?.desktopWrite).toEqual({
      session: "active",
      action: "click",
      control: null,
    });
    expect(h.cards[0]?.outcome).toEqual({
      behaviour: "ask",
      source: "desktop_action",
      reason: "没能确认要操作的控件，在窗口「」里执行前需要你批准。",
    });
    expect(lastWrite(h)).toMatchObject({ approved: true, ref: "abc123-9:1" });
    // No title known: an empty one, so the device asks again if the live title is sensitive.
    expect(lastWrite(h).approvedTitle).toBe("");
  });

  test("win+r is refused before any card or frame", async () => {
    for (const keys of ["win+r", "Win+R", "ctrl+shift+esc", "nonsense+key"]) {
      const h = harness({ session: true });
      const error = await h.gateway
        .pressDesktopKey("bot", ACTOR, { windowId: NOTEPAD.windowId, keys })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ActionRefusedError);
      expect((error as Error).message).toBe(
        desktopMessage("system_keys", keys),
      );
      expect(h.posts).toHaveLength(0);
      expect(h.cards).toHaveLength(0);
      expect(h.gated).toHaveLength(0);
      // One refusal row, naming the keys.
      expect(h.rows).toHaveLength(1);
      expect(h.rows[0]?.eventType).toBe("computer.action_refused");
      expect(h.payloads()[0]?.desktop).toMatchObject({ action: "key", keys });
    }
  });

  test("typed text never reaches audit_events, only its length; the approval card shows it", async () => {
    const text = "机密内容 SECRET-42\n第二行";
    const h = harness();
    await h.read();
    const args = { ref: "abc123-1:0", text, mode: "replace" as const };
    await withApprovalContext(CONTINUATION(args), () =>
      h.gateway.typeDesktop("bot", ACTOR, args),
    );
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]?.candidate.args).toEqual(args);
    expect(JSON.stringify(h.rows)).not.toContain("SECRET-42");
    expect(JSON.stringify(h.rows)).not.toContain("机密内容");
    const attempt = h
      .payloads()
      .find((row) => row.action === "computer_desktop_type");
    expect(attempt?.desktop).toEqual({
      windowId: NOTEPAD.windowId,
      title: NOTEPAD.title,
      process: "notepad",
      control: { type: "textarea", name: "正文" },
      action: "type",
      textLength: text.length,
    });
    // Nor on the card's target, subject or refusal row: only the card's own arguments (the
    // conversation's call) carry it.
    const {
      args: _args,
      continuation: _continuation,
      ...rest
    } = (h.cards[0] as Card).candidate;
    expect(JSON.stringify(rest)).not.toContain("SECRET-42");
    // The device gets the text itself.
    expect(lastWrite(h)).toMatchObject({
      ref: "abc123-1:0",
      text,
      mode: "replace",
    });
    // Without the conversation's arguments, the gateway's own stand-in has the length only.
    const g = harness({ session: true, gate: "allow" });
    await g.read();
    await g.gateway.typeDesktop("bot", ACTOR, {
      ref: "abc123-1:0",
      text: "plain SECRET-43",
      mode: "append",
    });
    expect(JSON.stringify(g.gated)).not.toContain("SECRET-43");
    expect(JSON.stringify(g.rows)).not.toContain("SECRET-43");
  });

  test("success forgets the window's controls: the next click on an old ref asks as 控件不明", async () => {
    const h = harness({ session: true });
    await h.read();
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" });
    expect(h.cards).toHaveLength(0);
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" });
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]?.outcome.reason).toBe(
      "没能确认要操作的控件，在窗口「」里执行前需要你批准。",
    );
    // Another window's controls are kept.
    await h.read(WECHAT.windowId);
    await h.gateway.focusDesktopWindow("bot", ACTOR, {
      windowId: NOTEPAD.windowId,
    });
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-2:1" });
    expect(h.cards).toHaveLength(1);
  });

  test("the device's outcomeUnknown comes back as 不确定这一步是否已经生效…, and nothing is retried", async () => {
    const unknown = desktopMessage("outcome_unknown");
    const h = harness({
      session: true,
      write: () => {
        throw new DeviceActionError(unknown, true);
      },
    });
    await h.read();
    const error = await h.gateway
      .clickDesktop("bot", ACTOR, { ref: "abc123-1:1" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceActionError);
    expect((error as Error).message).toBe(unknown);
    expect(
      (error as Error).message.startsWith("不确定这一步是否已经生效"),
    ).toBe(true);
    expect((error as DeviceActionError).outcomeUnknown).toBe(true);
    expect(h.writesPosted()).toHaveLength(1);
    expect(h.rows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
      "computer.action_allowed",
      "computer.action_failed",
    ]);
    // The failure row says how long it took, and still never what was clicked beyond the control.
    expect(h.payloads()[2]?.desktop).toMatchObject({
      action: "click",
      durationMs: expect.any(Number),
    });
  });

  test("the team's word list is sent to the device as actionWords", async () => {
    const h = harness({
      session: true,
      words: async () => ["归档", "  ", ""],
      teamWords: ["归档"],
    });
    await h.read(WECHAT.windowId);
    // 发送 is not on the team's list: let through, and the device is told the same list.
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-2:0" });
    expect(h.cards).toHaveLength(0);
    expect(lastWrite(h).actionWords).toEqual(["归档"]);
    // A list with nothing left in it is the default list.
    const g = harness({ session: true, words: async () => ["  "] });
    await g.gateway.focusDesktopWindow("bot", ACTOR, {
      windowId: NOTEPAD.windowId,
    });
    expect(lastWrite(g).actionWords).toEqual([...DEFAULT_DESKTOP_ACTION_WORDS]);
    const none = harness({ session: true, words: async () => null });
    await none.gateway.focusDesktopWindow("bot", ACTOR, {
      windowId: NOTEPAD.windowId,
    });
    expect(lastWrite(none).actionWords).toEqual([
      ...DEFAULT_DESKTOP_ACTION_WORDS,
    ]);
  });

  test("only the owner; a teammate is refused and nothing is sent", async () => {
    const h = harness({ owner: "mallory", session: true });
    const calls = [
      () => h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" }),
      () =>
        h.gateway.typeDesktop("bot", ACTOR, {
          ref: "abc123-1:0",
          text: "x".repeat(9_001),
          mode: "replace",
        }),
      () =>
        h.gateway.pressDesktopKey("bot", ACTOR, {
          windowId: NOTEPAD.windowId,
          keys: "win+r",
        }),
      () =>
        h.gateway.focusDesktopWindow("bot", ACTOR, {
          windowId: NOTEPAD.windowId,
        }),
    ];
    for (const call of calls) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ActionRefusedError);
      expect((error as Error).message).toBe(DESKTOP_OWNER_ONLY);
    }
    expect(h.posts).toHaveLength(0);
    expect(h.cards).toHaveLength(0);
    expect(h.early).toHaveLength(0);
  });

  test("text over 9000 bytes is refused before any frame", async () => {
    expect(DESKTOP_TEXT_TOO_LONG).toBe("文字太长，最多 9000 字节。");
    const h = harness({ session: true });
    await h.read();
    const sent = h.posts.length;
    // 3000 Chinese characters are 9000 bytes; one more byte is over.
    const error = await h.gateway
      .typeDesktop("bot", ACTOR, {
        ref: "abc123-1:0",
        text: `${"中".repeat(3_000)}a`,
        mode: "append",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionRefusedError);
    expect((error as Error).message).toBe(DESKTOP_TEXT_TOO_LONG);
    expect(h.posts).toHaveLength(sent);
    expect(h.cards).toHaveLength(0);
    expect(h.rows.at(-1)?.eventType).toBe("computer.action_refused");
    expect(JSON.stringify(h.rows.at(-1))).not.toContain("中中中");
    // Exactly 9000 bytes goes through.
    await h.gateway.typeDesktop("bot", ACTOR, {
      ref: "abc123-1:0",
      text: "中".repeat(3_000),
      mode: "append",
    });
    expect(lastWrite(h).text).toBe("中".repeat(3_000));
  });

  test("a password field is refused before any card or frame", async () => {
    const h = harness({ session: true });
    await h.read();
    const sent = h.posts.length;
    await expect(
      h.gateway.typeDesktop("bot", ACTOR, {
        ref: "abc123-1:3",
        text: "hunter2",
        mode: "replace",
      }),
    ).rejects.toThrow(desktopMessage("password_field"));
    expect(h.posts).toHaveLength(sent);
    expect(h.cards).toHaveLength(0);
    expect(JSON.stringify(h.rows)).not.toContain("hunter2");
  });
});

describe("carried over from the session gate (Task 16)", () => {
  test("a heartbeat's stop reaches the gateway's own session cache through the runner socket's options", async () => {
    const h = harness();
    await h.read();
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" });
    const options = runnerMessageOptions(h.gateway);
    expect(options.onDesktopStopped).toBeFunction();
    await options.onDesktopStopped?.(MACHINE, {
      botId: "bot",
      actorId: OWNER,
      reason: "hotkey",
    });
    const stopped = h.payloads().at(-1);
    expect(stopped).toMatchObject({
      action: "computer_desktop_session",
      reason: DESKTOP_STOPPED_REASON,
      stoppedBy: "hotkey",
    });
    expect(runnerMessageOptions(undefined)).toEqual({});
  });

  test("one owner check for reading and writing the desktop", async () => {
    const machine = await desktopOwnersMachine(
      async () => MACHINE,
      "bot",
      ACTOR,
    );
    expect(machine).toEqual(MACHINE);
    await expect(
      desktopOwnersMachine(async () => MACHINE, "bot", { id: "mallory" }),
    ).rejects.toThrow(DESKTOP_OWNER_ONLY);
    await expect(
      desktopOwnersMachine(async () => null, "bot", ACTOR),
    ).rejects.toBeInstanceOf(ComputerUnavailableError);
    await expect(desktopOwnersMachine(undefined, "bot", ACTOR)).rejects.toThrow(
      NO_DESKTOP,
    );
    // A Bot with no paired machine: the write is refused like the read, nothing sent.
    const h = harness();
    const gateway = createComputerGateway({
      provider: createDeviceComputerProvider(),
      auditStore: { insert: async () => undefined },
      policy: () => PERMISSIVE,
      transport: {} as ComputerTransport,
      resolveDevice: async () => null,
    });
    await expect(
      gateway.focusDesktopWindow("bot", ACTOR, { windowId: NOTEPAD.windowId }),
    ).rejects.toThrow(NO_DESKTOP);
    expect(h.posts).toHaveLength(0);
  });

  test("a done write starts the session's idle clock again when it is done", async () => {
    let clock = 0;
    const sessions = createDesktopSessionCache({ now: () => clock });
    const key = desktopSessionKey(MACHINE, "bot", OWNER);
    const token = "cd".repeat(32);
    sessions.set(key, token);
    const gate = createDesktopWriteGate({
      resolveDevice: async () => MACHINE,
      govern: (async (_tool, _bot, _actor, _subject, run) =>
        run(false)) as DesktopWriteGovern,
      post: async <T>() =>
        ({ writable: true, platform: "macos", session: { token } }) as T,
      sessions,
    });
    await gate.run(
      "computer_desktop_focus",
      "bot",
      ACTOR,
      {
        action: "focus",
        windowId: NOTEPAD.windowId,
        subject: { action: "focus", title: "t", process: "p" },
      },
      async () => {
        // A slow write: most of the idle time passes while the device works.
        clock += 800_000;
        return "sent";
      },
    );
    clock += 800_000;
    expect(sessions.get(key)).toBe(token);
  });

  test("only the device's exact end-of-session copy drops the session", async () => {
    for (const [message, dropped] of [
      [desktopMessage("stopped"), true],
      [`设备说：${desktopMessage("stopped")}`, false],
      [`${desktopMessage("session_expired")} `, false],
      [desktopMessage("no_session"), true],
    ] as const) {
      const sessions = createDesktopSessionCache();
      const key = desktopSessionKey(MACHINE, "bot", OWNER);
      const token = "cd".repeat(32);
      const gate = createDesktopWriteGate({
        resolveDevice: async () => MACHINE,
        govern: (async (_tool, _bot, _actor, subject, run) => {
          if (subject.refusal)
            throw new ActionRefusedError(subject.refusal, "x");
          return run(false);
        }) as DesktopWriteGovern,
        post: async <T>() =>
          ({ writable: true, platform: "macos", session: { token } }) as T,
        sessions,
      });
      await expect(
        gate.run(
          "computer_desktop_focus",
          "bot",
          ACTOR,
          {
            action: "focus",
            windowId: NOTEPAD.windowId,
            subject: { action: "focus", title: "t", process: "p" },
          },
          async () => {
            throw new DeviceActionError(message);
          },
        ),
      ).rejects.toThrow(message);
      expect({ message, kept: sessions.get(key) }).toEqual({
        message,
        kept: dropped ? undefined : token,
      });
    }
  });

  test("an error from the device never carries the session token", async () => {
    const h = harness({
      session: true,
      write: (_path, payload) => {
        throw new DeviceActionError(
          `bad session ${String(payload.session)} here`,
          true,
        );
      },
    });
    const error = await h.gateway
      .focusDesktopWindow("bot", ACTOR, { windowId: NOTEPAD.windowId })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceActionError);
    expect((error as DeviceActionError).outcomeUnknown).toBe(true);
    expect((error as Error).message).not.toMatch(HEX64);
    expect((error as Error).message).toContain("bad session");
    expect(JSON.stringify(h.rows)).not.toMatch(HEX64);
    // Nor a refused session_start.
    const sessions = createDesktopSessionCache();
    const gate = createDesktopWriteGate({
      resolveDevice: async () => MACHINE,
      govern: (async (_tool, _bot, _actor, subject, run) => {
        if (subject.refusal) throw new ActionRefusedError(subject.refusal, "x");
        return run(true);
      }) as DesktopWriteGovern,
      post: async <T>(_bot: string, path: string, payload: unknown) => {
        if (path === "/desktop/session_status")
          return { writable: true, platform: "macos" } as T;
        throw new Error(
          `refused ${String((payload as { token?: string }).token)}`,
        );
      },
      sessions,
    });
    const refused = await gate
      .run(
        "computer_desktop_focus",
        "bot",
        ACTOR,
        {
          action: "focus",
          windowId: NOTEPAD.windowId,
          subject: { action: "focus", title: "t", process: "p" },
        },
        async () => "sent",
      )
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ActionRefusedError);
    expect((refused as Error).message).toContain("refused");
    expect((refused as Error).message).not.toMatch(HEX64);
  });

  test("only a permit from the gate counts as approved: a write let through unasked opens no session", async () => {
    const h = harness({ gate: "allow" });
    await expect(
      h.gateway.focusDesktopWindow("bot", ACTOR, {
        windowId: NOTEPAD.windowId,
      }),
    ).rejects.toThrow(DESKTOP_SESSION_UNAPPROVED);
    expect(h.paths()).not.toContain("/desktop/session_start");
    expect(h.writesPosted()).toHaveLength(0);
    // In a session, a write let through unasked is sent as not approved.
    const g = harness({ gate: "allow", session: true });
    await g.gateway.focusDesktopWindow("bot", ACTOR, {
      windowId: NOTEPAD.windowId,
    });
    expect(lastWrite(g).approved).toBe(false);
  });

  test("the approved action carried out by its approval's resume counts as approved", async () => {
    await runAsTenant(OWNER, async () => {
      const { rows, service } = approvalFixture();
      const h = harness({ gate: (candidate) => service.gate(candidate) });
      const args = { windowId: NOTEPAD.windowId };
      const focus = () =>
        h.gateway.focusDesktopWindow("bot", ACTOR, {
          windowId: NOTEPAD.windowId,
        });
      // Asked: the run waits for the owner, nothing is sent.
      await expect(
        withApprovalContext(
          { ...CONTINUATION(args), toolName: "computer_desktop_focus" },
          focus,
        ),
      ).rejects.toBeInstanceOf(HeadlessToolSuspension);
      expect(h.writesPosted()).toHaveLength(0);
      // Approved, and carried out by the server: the gate answers with no permit there.
      (rows.get("approval") as ApprovalRecord).status = "approved";
      const action = (rows.get("approval") as ApprovalRecord).action;
      let inside = false;
      await service.resume(OWNER, "approval", {
        validate: async () => action,
        execute: async () => {
          const candidate = h.gated.at(-1) as ApprovalCandidate;
          const result = await focus();
          inside = isApprovedExecution(h.gated.at(-1) as ApprovalCandidate);
          expect(approvalAction(candidate).actionDigest).toBe(
            action.actionDigest,
          );
          return result;
        },
        continue: async () => {},
      } as never);
      expect(inside).toBe(true);
      expect(h.paths()).toContain("/desktop/session_start");
      expect(lastWrite(h)).toMatchObject({ approved: true });
      // Outside that run, nothing is an approved execution.
      expect(isApprovedExecution(h.gated.at(-1) as ApprovalCandidate)).toBe(
        false,
      );
    });
  });
});

describe("round 2 of review", () => {
  test("a done write whose done row cannot be written is still done, and is not sent again", async () => {
    const h = harness({
      session: true,
      auditFails: (row) => row.eventType === "computer.desktop_write_done",
    });
    await h.read();
    const result = await h.gateway.clickDesktop("bot", ACTOR, {
      ref: "abc123-1:1",
    });
    expect(result.ok).toBe(true);
    expect(h.writesPosted()).toHaveLength(1);
    // The attempt row was written; the done row was not, and nothing claims the write failed.
    expect(h.rows.map((row) => row.eventType)).not.toContain(
      "computer.action_failed",
    );
  });

  test("on Activity a done write is one row: its done row, which carries what the attempt row did", async () => {
    const h = harness({ session: true });
    await h.read();
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" });
    const writes = h.rows.filter(
      (row) =>
        (row.payload as Record<string, unknown>).action ===
        "computer_desktop_click",
    );
    expect(writes.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
      "computer.desktop_write_done",
    ]);
    const shown = oneRowPerAction(writes);
    expect(shown.map((row) => row.eventType)).toEqual([
      "computer.desktop_write_done",
    ]);
    // Everything the attempt row said is on the done row too, which adds how it went.
    const [attempt, done] = writes as [AuditEventInput, AuditEventInput];
    const { desktop: attemptDesktop, ...attemptRest } =
      attempt.payload as Record<string, unknown>;
    const { desktop: doneDesktop, ...doneRest } = done.payload as Record<
      string,
      unknown
    >;
    expect(doneRest).toEqual(attemptRest);
    expect(doneDesktop).toMatchObject({
      ...(attemptDesktop as object),
      physical: false,
      delivery: "verified",
      durationMs: expect.any(Number),
    });
  });
});

describe("round 1 of review", () => {
  test("a write approved while the session was on is not carried out once the device has ended it", async () => {
    await runAsTenant(OWNER, async () => {
      const fixture = approvalFixture();
      const h = harness({
        session: true,
        gate: (candidate) => fixture.service.gate(candidate),
      });
      const args = { windowId: NOTEPAD.windowId };
      const focus = () => h.gateway.focusDesktopWindow("bot", ACTOR, args);
      const context = {
        ...CONTINUATION(args),
        toolName: "computer_desktop_focus",
      };
      await expect(withApprovalContext(context, focus)).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      // The owner stops the session (or it runs out) before the approval is carried out.
      h.endSession();
      const answered = await approveAndResume(fixture, () =>
        withApprovalContext(context, focus),
      );
      expect(h.paths()).not.toContain("/desktop/session_start");
      expect(h.writesPosted()).toHaveLength(0);
      expect(answered.result?.error).toContain(
        "The approved action or resolved target has changed.",
      );
    });
  });

  test("a done write leaves a computer.desktop_write_done row with how it went, and never the text", async () => {
    const h = harness({ session: true });
    await h.read();
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" });
    const attempt = h
      .payloads()
      .find((row) => row.action === "computer_desktop_click");
    const done = h.rows.filter(
      (row) => row.eventType === "computer.desktop_write_done",
    );
    expect(done).toHaveLength(1);
    expect(done[0]?.targetType).toBe("computer");
    expect(done[0]?.payload).toMatchObject({
      action: "computer_desktop_click",
      bot: "bot",
      attempt: attempt?.attempt,
      desktop: {
        windowId: NOTEPAD.windowId,
        title: NOTEPAD.title,
        process: "notepad",
        control: { type: "button", name: "确定" },
        action: "click",
        physical: false,
        delivery: "verified",
        durationMs: expect.any(Number),
      },
    });
    expect(typeof attempt?.attempt).toBe("string");
    // Typing: the length, never the text.
    await h.read();
    await h.gateway.typeDesktop("bot", ACTOR, {
      ref: "abc123-1:0",
      text: "SECRET-77 正文",
      mode: "append",
    });
    const typed = h.rows.filter(
      (row) => row.eventType === "computer.desktop_write_done",
    )[1];
    expect((typed as AuditEventInput).payload.desktop).toMatchObject({
      action: "type",
      textLength: "SECRET-77 正文".length,
    });
    expect(JSON.stringify(h.rows)).not.toContain("SECRET-77");
    // A failed write has no such row.
    const g = harness({
      session: true,
      write: () => {
        throw new DeviceActionError(desktopMessage("stale"));
      },
    });
    await g.gateway
      .focusDesktopWindow("bot", ACTOR, { windowId: NOTEPAD.windowId })
      .catch(() => undefined);
    expect(
      g.rows.filter((row) => row.eventType === "computer.desktop_write_done"),
    ).toHaveLength(0);
  });

  test("an approval answered after this replica forgot the control is carried out with the control it bound", async () => {
    await runAsTenant(OWNER, async () => {
      let clock = 1_000;
      const fixture = approvalFixture();
      const h = harness({
        now: () => clock,
        gate: (candidate) => fixture.service.gate(candidate),
      });
      await h.read();
      const args = { ref: "abc123-1:1" };
      const click = () => h.gateway.clickDesktop("bot", ACTOR, args);
      const context = {
        ...CONTINUATION(args),
        toolName: "computer_desktop_click",
      };
      await expect(withApprovalContext(context, click)).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      const asked = h.gated.at(-1) as ApprovalCandidate;
      expect(asked.subject?.desktopWrite?.control).toEqual({
        type: "button",
        name: "确定",
      });
      // Answered later than this replica keeps its lists.
      clock += 300_001;
      const answered = await approveAndResume(fixture, () =>
        withApprovalContext(context, click),
      );
      expect(answered.result?.error).toBeUndefined();
      expect(h.paths()).toContain("/desktop/session_start");
      expect(lastWrite(h)).toMatchObject({
        approved: true,
        ref: "abc123-1:1",
        approvedTitle: NOTEPAD.title,
      });
      // The window was asked for again (its title is checked, never assumed).
      expect(
        h.paths().filter((path) => path === "/desktop/windows"),
      ).toHaveLength(2);
      // Outside an approval's own run, a forgotten control still asks as unknown.
      const g = harness({ session: true, now: () => clock });
      await g.read();
      clock += 300_001;
      await g.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" });
      expect(g.cards[0]?.candidate.subject?.desktopWrite?.control).toBeNull();
    });
  });

  test("an approval whose window title changed since is not carried out", async () => {
    await runAsTenant(OWNER, async () => {
      let clock = 1_000;
      const fixture = approvalFixture();
      let windows = [NOTEPAD, WECHAT];
      const h = harness({
        now: () => clock,
        gate: (candidate) => fixture.service.gate(candidate),
        windowsList: () => windows,
      });
      await h.read();
      const args = { ref: "abc123-1:1" };
      const click = () => h.gateway.clickDesktop("bot", ACTOR, args);
      const context = {
        ...CONTINUATION(args),
        toolName: "computer_desktop_click",
      };
      await expect(withApprovalContext(context, click)).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      clock += 300_001;
      windows = [{ ...NOTEPAD, title: "网上银行 - 记事本" }, WECHAT];
      const answered = await approveAndResume(fixture, () =>
        withApprovalContext(context, click),
      );
      expect(answered.result?.error).toContain(
        "The approved action or resolved target has changed.",
      );
      expect(h.writesPosted()).toHaveLength(0);
    });
  });
});

describe("carried over from the per-action floors (Task 17)", () => {
  test("the early refusal knows it is a desktop write: the team's cap of never refuses before the device is asked", async () => {
    const h = harness({
      refusal: (candidate) =>
        refusedOutright({
          candidate,
          team: [],
          personal: [],
          customRulesEnabled: true,
          hostCommandsCap: "never",
        })?.reason,
    });
    await h.read();
    const sent = h.posts.length;
    const asked = h.early.length;
    await expect(
      h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    expect(h.posts).toHaveLength(sent);
    expect(h.cards).toHaveLength(0);
    expect(h.early.length).toBeGreaterThan(asked);
    for (const candidate of h.early.slice(asked))
      expect(candidate.subject?.desktopWrite?.action).toBe("click");
  });
});

describe("carried over from the device's writes (Task 21)", () => {
  test("every write carries the title the owner saw, asked or not", async () => {
    // Asked (opening the session): the card's title.
    const h = harness();
    await h.read(WECHAT.windowId);
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-2:1" });
    expect(h.cards[0]?.candidate.subject?.desktopWrite?.title).toBe("微信");
    expect(lastWrite(h)).toMatchObject({
      approved: true,
      approvedTitle: "微信",
    });
    // Let through in the session: the title this server holds.
    await h.gateway.pressDesktopKey("bot", ACTOR, {
      windowId: WECHAT.windowId,
      keys: "ctrl+s",
    });
    expect(h.cards).toHaveLength(1);
    expect(lastWrite(h)).toEqual({
      session: h.token(),
      botId: "bot",
      actorId: OWNER,
      approved: false,
      actionWords: [...DEFAULT_DESKTOP_ACTION_WORDS],
      approvedTitle: "微信",
      windowId: WECHAT.windowId,
      keys: "ctrl+s",
    });
  });

  test("the device's four further checks ask on the server too", async () => {
    const write = (
      over: Partial<NonNullable<ApprovalSubject["desktopWrite"]>>,
    ): ApprovalCandidate => ({
      actorId: OWNER,
      botId: "bot",
      toolRef: "computer_desktop_key",
      effect: "write",
      scope: "desktop/wechat",
      args: {},
      subject: {
        runner: true,
        desktopWrite: {
          session: "active",
          action: "key",
          title: "微信",
          process: "wechat",
          ...over,
        },
      },
    });
    const words = DEFAULT_DESKTOP_ACTION_WORDS;
    for (const keys of ["space", "shift+space", "Space"])
      expect(desktopActionReason(write({ keys }), words)).toBe(
        "这个按键可能会按下当前选中的按钮，需要你先确认。",
      );
    for (const keys of ["ctrl+space", "a"])
      expect(desktopActionReason(write({ keys }), words)).toBeUndefined();
    expect(
      desktopActionReason(
        write({
          action: "type",
          control: { type: "button", name: "确定" },
          notTextTarget: true,
        }),
        words,
      ),
    ).toBe("目标不是输入框，需要你先确认。");
    expect(
      desktopActionReason(
        write({
          action: "type",
          control: { type: "textarea", name: "正文" },
          controlCharacters: true,
        }),
        words,
      ),
    ).toBe("输入的文字含控制字符或特殊的换行符，需要你先确认。");
    for (const name of ["", "  "])
      expect(
        desktopActionReason(
          write({ action: "click", control: { type: "button", name } }),
          words,
        ),
      ).toBe("没能确认要操作的控件，在窗口「微信」里执行前需要你批准。");

    // Through the gateway, from what it read: Space, a non-text target, a tab, an unnamed button.
    const h = harness({ session: true });
    await h.read();
    await h.gateway.pressDesktopKey("bot", ACTOR, {
      windowId: NOTEPAD.windowId,
      keys: "space",
    });
    await h.read();
    await h.gateway.typeDesktop("bot", ACTOR, {
      ref: "abc123-1:1",
      text: "hi",
      mode: "append",
    });
    await h.read();
    await h.gateway.typeDesktop("bot", ACTOR, {
      ref: "abc123-1:0",
      text: "a\tb",
      mode: "append",
    });
    await h.read();
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:4" });
    expect(h.cards.map((card) => card.outcome.reason)).toEqual([
      "这个按键可能会按下当前选中的按钮，需要你先确认。",
      "目标不是输入框，需要你先确认。",
      "输入的文字含控制字符或特殊的换行符，需要你先确认。",
      `没能确认要操作的控件，在窗口「${NOTEPAD.title}」里执行前需要你批准。`,
    ]);
    // A newline in a multi-line box, or plain text, does not ask; a newline in a single-line one does.
    const g = harness({ session: true });
    await g.read();
    await g.gateway.typeDesktop("bot", ACTOR, {
      ref: "abc123-1:0",
      text: "a\r\nb",
      mode: "append",
    });
    expect(g.cards).toHaveLength(0);
    await g.read();
    await g.gateway.typeDesktop("bot", ACTOR, {
      ref: "abc123-1:2",
      text: "a\nb",
      mode: "append",
    });
    expect(g.cards[0]?.candidate.subject?.desktopWrite).toMatchObject({
      newlineInSingleLine: true,
      controlCharacters: true,
    });
    expect(g.cards[0]?.outcome.reason).toBe(
      `往窗口「${NOTEPAD.title}」的单行输入框「搜索」里输入带换行的文字，相当于提交，需要你批准。`,
    );
  });

  const needs = (reason: string) => desktopMessage("needs_approval", reason);

  test("a device that asks for approval the server did not ask for: one card with its reason, then sent once more approved", async () => {
    const h = harness({
      session: true,
      write: (_path, payload, call) => {
        if (call === 1) {
          expect(payload.approved).toBe(false);
          throw new DeviceActionError(needs("控件名含「发送」"));
        }
        return {
          physical: true,
          durationMs: 5,
          delivery: "unverified",
          window: {
            windowId: NOTEPAD.windowId,
            title: NOTEPAD.title,
            process: "notepad",
          },
          note: "n",
        };
      },
    });
    await h.read();
    const result = await h.gateway.clickDesktop("bot", ACTOR, {
      ref: "abc123-1:1",
    });
    expect(result.physical).toBe(true);
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]?.outcome).toEqual({
      behaviour: "ask",
      source: "desktop_action",
      reason: "设备端核对后认为这一步需要你批准：控件名含「发送」。",
    });
    expect(h.cards[0]?.candidate.subject?.desktopWrite).toMatchObject({
      deviceReason: "控件名含「发送」",
    });
    expect(h.writesPosted()).toHaveLength(2);
    expect(lastWrite(h)).toMatchObject({
      approved: true,
      approvedTitle: NOTEPAD.title,
      ref: "abc123-1:1",
    });
  });

  test("a device that still asks after the owner approved is answered in its own words, never asked again", async () => {
    // Approved on the card (opening the session), and the device asks anyway: the title changed.
    const changed = needs("窗口标题刚刚变成含「银行」，请重新列出窗口");
    const h = harness({
      write: () => {
        throw new DeviceActionError(changed);
      },
    });
    await h.read();
    await expect(
      h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" }),
    ).rejects.toThrow(changed);
    expect(h.cards).toHaveLength(1);
    expect(h.writesPosted()).toHaveLength(1);
    // Not approved, re-asked once, and the device asks again: no third send, no second card of ours.
    const g = harness({
      session: true,
      write: () => {
        throw new DeviceActionError(needs("目标不是输入框，需要你先确认。"));
      },
    });
    await g.read();
    await expect(
      g.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" }),
    ).rejects.toThrow(needs("目标不是输入框，需要你先确认。"));
    expect(g.cards).toHaveLength(1);
    expect(g.cards[0]?.outcome.reason).toBe(
      "设备端核对后认为这一步需要你批准：目标不是输入框，需要你先确认。",
    );
    expect(g.writesPosted()).toHaveLength(2);
    expect(g.writesPosted().map((post) => post.payload.approved)).toEqual([
      false,
      true,
    ]);
  });
});

describe("the controls a read showed", () => {
  test("kept per window, replaced by its next snapshot, forgotten after a write, and only for five minutes", () => {
    let clock = 0;
    const controls = createDesktopControlCache({ now: () => clock });
    const key = "owner/dev-1/bot";
    const snapshot = (
      window: DesktopWindow,
      elements: unknown[],
    ): DesktopSnapshot =>
      ({ snapshotId: "x", window, truncated: false, elements }) as never;
    controls.rememberSnapshot(
      key,
      snapshot(NOTEPAD, [
        ...(ELEMENTS[NOTEPAD.windowId] ?? []),
        // Untrusted: not a ref, no name, not an object at all.
        { ref: "e1", type: "button", name: "x", depth: 0 },
        { ref: "abc123-1:9", type: "button", depth: 0 },
        null,
      ]),
    );
    controls.rememberSnapshot(
      key,
      snapshot(WECHAT, ELEMENTS[WECHAT.windowId] ?? []),
    );
    expect(controls.control(key, "abc123-1:2")).toEqual({
      windowId: NOTEPAD.windowId,
      type: "textfield",
      name: "搜索",
      singleLine: true,
    });
    expect(controls.control(key, "abc123-1:3")?.password).toBe(true);
    expect(controls.control(key, "e1")).toBeUndefined();
    expect(controls.control(key, "abc123-1:9")).toBeUndefined();
    expect(controls.control("owner/dev-1/other", "abc123-1:2")).toBeUndefined();
    // The window's next snapshot replaces its refs.
    controls.rememberSnapshot(
      key,
      snapshot(NOTEPAD, [
        { ref: "abc123-3:0", type: "button", name: "好", depth: 0 },
      ]),
    );
    expect(controls.control(key, "abc123-1:2")).toBeUndefined();
    expect(controls.control(key, "abc123-3:0")?.name).toBe("好");
    // A write forgets its window only.
    controls.forgetWindow(key, NOTEPAD.windowId);
    expect(controls.control(key, "abc123-3:0")).toBeUndefined();
    expect(controls.control(key, "abc123-2:0")?.name).toBe("发送");
    // Five minutes on, nothing is known.
    clock = 300_001;
    expect(controls.control(key, "abc123-2:0")).toBeUndefined();
  });
});
