import { afterEach, describe, expect, test } from "bun:test";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { oneRowPerAction } from "../../shared/activity-rows";
import {
  DEFAULT_DESKTOP_ACTION_WORDS,
  DESKTOP_LIMITS,
  type DesktopElement,
  type DesktopSnapshot,
  type DesktopWindow,
  desktopMessage,
} from "../../shared/desktop-control";
import {
  DESKTOP_CLIPBOARD_READ_REASON,
  DESKTOP_SESSION_REASON,
  desktopActionReason,
  desktopCardWithDeviceReasons,
  desktopSelfWindowWords,
  desktopWindowReason,
} from "../src/approvals/desktop-policy";
import {
  decideAction,
  HOST_COMMANDS_NEVER,
  refusedOutright,
  TOOL_DISABLED,
} from "../src/approvals/policy";
import {
  isApprovalRecheck,
  isApprovedExecution,
  TASK_ASKS,
} from "../src/approvals/service";
import {
  type ApprovalCandidate,
  type ApprovalContinuation,
  type ApprovalPolicyOutcome,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalRule,
  type ApprovalStore,
  type ApprovalSubject,
  approvalAction,
  withApprovalContext,
} from "../src/approvals/types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { resetBrand, setBrand } from "../src/brand";
import { computerActionIdentity } from "../src/computer/action-identity";
import {
  type ComputerTransport,
  ComputerUnavailableError,
} from "../src/computer/client";
import {
  DESKTOP_BACKSTOP_MS,
  DESKTOP_OWNER_ONLY,
  DESKTOP_WAIT_TARGET,
  desktopOwnersMachine,
  NO_DESKTOP,
} from "../src/computer/desktop-gateway";
import {
  createDesktopSessionCache,
  desktopSessionKey,
} from "../src/computer/desktop-session";
import { createDesktopControlCache } from "../src/computer/desktop-state";
import { desktopTools } from "../src/computer/desktop-tools";
import {
  createDesktopReasonMemory,
  createDesktopWriteGate,
  DESKTOP_APPROVED_AGAIN,
  DESKTOP_BAD_APP,
  DESKTOP_REASONS_KEPT,
  DESKTOP_REASONS_TTL_MS,
  DESKTOP_SESSION_UNAPPROVED,
  DESKTOP_STOPPED_REASON,
  DESKTOP_TEXT_TOO_LONG,
  type DesktopWriteGovern,
  desktopCallAgain,
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
import { withUntrustedNotice } from "../src/untrusted-content";
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
    /**
     * The runner's action journal (runner/src/journal.ts) in front of the device: a keyed request is
     * carried out once and its outcome replayed for the same key and payload; the same key with a
     * different payload is refused as it is there.
     */
    journal?: boolean;
    /** The approval store keeps one request per tool call, as production's does (round 3). */
    onePerCall?: boolean;
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
  const keys: { path: string; key: string | undefined }[] = [];
  const timeouts: { path: string; timeoutMs: number | undefined }[] = [];
  const journal = new Map<
    string,
    { fingerprint: string; outcome: Promise<unknown> }
  >();
  const transport: ComputerTransport = {
    async post<T>(
      address: string,
      botId: string,
      path: string,
      payload: unknown,
      _caller?: AbortSignal,
      timeoutMs?: number,
      key?: string,
    ): Promise<T> {
      expect(address).toBe(runnerAddress(MACHINE));
      expect(botId).toBe("bot");
      keys.push({ path, key });
      timeouts.push({ path, timeoutMs });
      if (!options.journal || !key) return device<T>(path, payload);
      const fingerprint = JSON.stringify([path, payload]);
      const row = journal.get(key);
      if (row && row.fingerprint !== fingerprint)
        throw new DeviceActionError(
          "This action id belongs to another request.",
        );
      if (row) return row.outcome as Promise<T>;
      const outcome = device<T>(path, payload);
      journal.set(key, { fingerprint, outcome });
      return outcome;
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
  /** The machine itself, behind the journal. */
  async function device<T>(path: string, payload: unknown): Promise<T> {
    {
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
    }
  }
  /** A gateway over this device: another one is another replica (its own memory and caches). */
  const replica = () =>
    createComputerGateway({
      provider: createDeviceComputerProvider(),
      auditStore: audit,
      policy: () => PERMISSIVE,
      transport,
      ...(options.now ? { now: options.now } : {}),
      ...(options.onePerCall ? { desktopOneApprovalPerCall: true } : {}),
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
          ...(options.teamWords
            ? { desktopActionWords: options.teamWords }
            : {}),
        });
        if (outcome.behaviour === "deny")
          throw new ApprovalRefusedError(outcome.reason);
        if (outcome.behaviour === "allow") return undefined;
        cards.push({ candidate, outcome });
        /*
         * Approved at once: the permit carries what the card named of the device's reasons, as the
         * approval service's carries what its request kept (round 4).
         */
        const kept = desktopCardWithDeviceReasons(
          candidate,
          outcome,
        ).deviceReasons;
        return {
          complete: async () => undefined,
          ...(kept ? { deviceReasons: kept } : {}),
        };
      },
      approvalRefusal: async (candidate) => {
        early.push(candidate);
        return options.refusal?.(candidate);
      },
    });
  const gateway = replica();
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
    /** Another replica over the same device, journal and audit store (round 4). */
    replica,
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
    /** The dispatch key each post carried (undefined: none, a fresh one per frame). */
    keys,
    /** How long the gateway gave each post. */
    timeouts,
    /** The device's session replaced by another (stopped, then opened again for another write). */
    renewSession: () => {
      token = "ef".repeat(32);
    },
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
      // Final review C1 and I1: the product's names, and the control's name the card showed.
      selfWindowWords: ["熊宝数字员工", "熊宝", "XiongBao Work"],
      approvedControlName: "确定",
      // Final review round 2 (Important-2): the process the card showed.
      approvedProcess: "notepad",
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

describe("the approved resend through the runner's journal", () => {
  test("a write approved inside a session is carried out with the session the device holds then", async () => {
    await runAsTenant(OWNER, async () => {
      const fixture = approvalFixture();
      const h: ReturnType<typeof harness> = harness({
        session: true,
        journal: true,
        gate: (candidate) => fixture.service.gate(candidate),
        write: (_path, payload) => {
          // The device knows only its current session.
          if (payload.session !== h.token())
            throw new DeviceActionError(desktopMessage("no_session"));
          return {
            physical: false,
            durationMs: 3,
            delivery: "verified",
            window: {
              windowId: WECHAT.windowId,
              title: WECHAT.title,
              process: "wechat",
            },
            note: "n",
          };
        },
      });
      await h.read(WECHAT.windowId);
      const args = { ref: "abc123-2:0" };
      const context = {
        ...CONTINUATION(args),
        toolName: "computer_desktop_click",
      };
      const click = () =>
        withApprovalContext(context, () =>
          computerActionIdentity.run("call-9", () =>
            h.gateway.clickDesktop("bot", ACTOR, args),
          ),
        );
      // Clicking 发送 in the session asks first: the run waits for the owner.
      await expect(click()).rejects.toBeInstanceOf(HeadlessToolSuspension);
      // Meanwhile the session on the device is replaced; the write is still one inside a session.
      h.renewSession();
      const answered = await approveAndResume(fixture, click);
      // Carried out: a result with content and no error.
      expect(answered.result).toEqual({ content: expect.any(String) });
      expect(h.writesPosted()).toHaveLength(1);
      expect(lastWrite(h)).toMatchObject({
        session: h.token(),
        approved: true,
        ref: "abc123-2:0",
      });
      // Every question about the session went out afresh, never under the call's own key.
      const asked = h.keys.filter(
        (sent) => sent.path === "/desktop/session_status",
      );
      expect(asked.length).toBeGreaterThan(1);
      expect(asked.filter((sent) => sent.key !== undefined)).toEqual([]);
    });
  });

  test("the device asks, the run waits for the owner, and the approved run is carried out under the approved key", async () => {
    await runAsTenant(OWNER, async () => {
      const fixture = approvalFixture();
      const needs = desktopMessage("needs_approval", "控件名含「发送」");
      let carriedOut = 0;
      let permitAll = false;
      const h = harness({
        session: true,
        journal: true,
        /*
         * The policy lets a plain click in a session through; only the device's own reason asks
         * (the approval service), and so do the approval's re-check and its run, as they do there.
         */
        gate: async (candidate) => {
          if (permitAll) return { complete: async () => undefined };
          return !candidate.subject?.desktopWrite?.deviceReason &&
            !isApprovalRecheck() &&
            !isApprovedExecution(candidate)
            ? undefined
            : fixture.service.gate(candidate);
        },
        write: (_path, payload) => {
          if (payload.approved !== true) throw new DeviceActionError(needs);
          carriedOut += 1;
          return {
            physical: false,
            durationMs: 3,
            delivery: "verified",
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
      const args = { ref: "abc123-1:1" };
      const context = {
        ...CONTINUATION(args),
        toolName: "computer_desktop_click",
      };
      const click = () =>
        withApprovalContext(context, () =>
          computerActionIdentity.run("call-11", () =>
            h.gateway.clickDesktop("bot", ACTOR, args),
          ),
        );
      // Sent unapproved, the device asks; asked with its reason, the run waits for the owner.
      await expect(click()).rejects.toBeInstanceOf(HeadlessToolSuspension);
      expect(carriedOut).toBe(0);
      // Approved and carried out by the server: the whole tool runs again.
      await h.read();
      const answered = await approveAndResume(fixture, click);
      expect(answered.result).toEqual({ content: expect.any(String) });
      expect(carriedOut).toBe(1);
      const first = JSON.stringify(["bot", "/desktop/click", "call-11"]);
      const approvedKey = JSON.stringify([
        "bot",
        "/desktop/click",
        "call-11:approved",
      ]);
      const sent = h.keys.filter((post) => post.path === "/desktop/click");
      expect(sent.map((post) => post.key)).toEqual([first, approvedKey]);
      // The approved write again (a replay): the journal answers it; the device does nothing more.
      await h.read();
      permitAll = true;
      const replayed = await click();
      expect(replayed.ok).toBe(true);
      expect(carriedOut).toBe(1);
      expect(
        h.keys.filter((post) => post.path === "/desktop/click").at(-1)?.key,
      ).toBe(approvedKey);
    });
  });

  test("the device asks, the owner approves, and the resend is carried out under its own key", async () => {
    const needs = desktopMessage("needs_approval", "控件名含「发送」");
    const h = harness({
      session: true,
      journal: true,
      write: (_path, payload) => {
        if (payload.approved !== true) throw new DeviceActionError(needs);
        return {
          physical: false,
          durationMs: 3,
          delivery: "verified",
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
    const click = () =>
      computerActionIdentity.run("call-7", () =>
        h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" }),
      );
    const result = await click();
    expect(result.ok).toBe(true);
    expect(h.cards).toHaveLength(1);
    const writeKeys = h.keys
      .filter((sent) => sent.path === "/desktop/click")
      .map((sent) => sent.key);
    expect(h.writesPosted().map((post) => post.payload.approved)).toEqual([
      false,
      true,
    ]);
    const first = JSON.stringify(["bot", "/desktop/click", "call-7"]);
    const resend = JSON.stringify(["bot", "/desktop/click", "call-7:approved"]);
    expect(writeKeys).toEqual([first, resend]);
    // The same call carried out again (a replay, with the window read again so it is the same
    // request) uses the same two keys: the journal answers both, and the device does nothing more.
    await h.read();
    const before = h.writesPosted().length;
    const replayed = await click();
    expect(replayed.ok).toBe(true);
    expect(h.writesPosted()).toHaveLength(before);
    expect(
      h.keys
        .filter((sent) => sent.path === "/desktop/click")
        .map((sent) => sent.key),
    ).toEqual([first, resend, first, resend]);
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
      // Carried out: a result with content and no error.
      expect(answered.result).toEqual({ content: expect.any(String) });
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
      // Final review C1: the product's names, for the device's check of the live title.
      selfWindowWords: ["熊宝数字员工", "熊宝", "XiongBao Work"],
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

  test("a device that still asks after the owner approved is asked about once more, then answered in its own words", async () => {
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
    // Final review I1: an approval is for what the card showed, so the device's reason is asked
    // about once more (a second card, a second send); asked again after that, never a third.
    expect(h.cards).toHaveLength(2);
    expect(h.writesPosted()).toHaveLength(2);
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

describe("waiting, launching and the clipboard (Task 25)", () => {
  const BANK: DesktopWindow = {
    windowId: "a1111111111111111",
    title: "招商银行 - 网上银行",
    process: "bank",
    focused: false,
    minimized: false,
  };
  /** What the device answers a wait: the window's snapshot, as `/desktop/snapshot` does. */
  const waited = (window: DesktopWindow): DesktopSnapshot => ({
    snapshotId: "abc123-7",
    window,
    truncated: false,
    elements: [{ ref: "abc123-7:0", type: "button", name: "登录", depth: 0 }],
  });
  /** The tools as the headless middleware builds them, parsing their arguments first. */
  const toolsOver = (h: ReturnType<typeof harness>) =>
    desktopTools(
      (name, _description, schema, execute) =>
        ({
          definition: { name },
          execute: async (args: unknown) =>
            execute(schema.parse(args), {
              toolCallId: "call-t",
              signal: new AbortController().signal,
            }),
        }) as never,
      { gateway: h.gateway, botId: "bot", actor: ACTOR },
    );
  const toolOf = (h: ReturnType<typeof harness>, name: string) => {
    const tool = toolsOver(h).find(
      (candidate) => candidate.definition.name === name,
    );
    if (!tool) throw new Error(`No tool ${name}.`);
    return tool;
  };

  test("reading the clipboard asks every time, even in a session, and the row has only its length", async () => {
    const secret = "验证码 314159 SECRET-CLIP";
    const h = harness({
      session: true,
      write: (path) => {
        expect(path).toBe("/desktop/clipboard_read");
        return { text: secret, truncated: false, durationMs: 4 };
      },
    });
    expect(intentOf("computer_desktop_clipboard_read", undefined)).toBe("read");
    for (const call of ["call-a", "call-b"]) {
      const result = await computerActionIdentity.run(call, () =>
        h.gateway.readDesktopClipboard("bot", ACTOR),
      );
      // Outside content: marked as untrusted data before the model reads it.
      expect(result).toEqual(
        withUntrustedNotice(
          { ok: true, text: secret, truncated: false },
          "desktop clipboard",
          ["text"],
        ),
      );
    }
    // Asked both times, inside the session, with the clipboard's own reason only.
    expect(h.cards).toHaveLength(2);
    for (const card of h.cards) {
      expect(card.candidate.toolRef).toBe("computer_desktop_clipboard_read");
      expect(card.candidate.subject?.desktopWrite).toEqual({
        session: "active",
        action: "clipboard_read",
      });
      expect(card.outcome).toEqual({
        behaviour: "ask",
        source: "desktop_action",
        reason: DESKTOP_CLIPBOARD_READ_REASON,
      });
    }
    // Sent approved, under the approved key, never under the call's own.
    const reads = h.posts.filter(
      (post) => post.path === "/desktop/clipboard_read",
    );
    expect(reads).toHaveLength(2);
    expect(reads[0]?.payload).toEqual({
      session: h.token(),
      botId: "bot",
      actorId: OWNER,
      approved: true,
      actionWords: [...DEFAULT_DESKTOP_ACTION_WORDS],
      approvedTitle: "",
    });
    expect(
      h.keys
        .filter((sent) => sent.path === "/desktop/clipboard_read")
        .map((sent) => sent.key),
    ).toEqual([
      JSON.stringify(["bot", "/desktop/clipboard_read", "call-a:approved"]),
      JSON.stringify(["bot", "/desktop/clipboard_read", "call-b:approved"]),
    ]);
    // The trail: what was read by its length, never the text.
    expect(JSON.stringify(h.rows)).not.toContain("SECRET-CLIP");
    expect(JSON.stringify(h.rows)).not.toContain("314159");
    const done = h.rows.filter(
      (row) => row.eventType === "computer.desktop_write_done",
    );
    expect(done).toHaveLength(2);
    expect(done[0]?.payload).toMatchObject({
      action: "computer_desktop_clipboard_read",
      desktop: { action: "clipboard_read", textLength: secret.length },
    });
    // With no session, one card opens the session and reads: both sentences, the session's first.
    const g = harness({
      write: () => ({ text: "x", truncated: false, durationMs: 1 }),
    });
    await g.gateway.readDesktopClipboard("bot", ACTOR);
    expect(g.cards).toHaveLength(1);
    expect(g.cards[0]?.outcome).toEqual({
      behaviour: "ask",
      source: "desktop_action",
      reason: `${DESKTOP_SESSION_REASON}${DESKTOP_CLIPBOARD_READ_REASON}`,
    });
    expect(g.paths().slice(-3)).toEqual([
      "/desktop/session_status",
      "/desktop/session_start",
      "/desktop/clipboard_read",
    ]);
  });

  test("launch is governed by the team cap like a command", async () => {
    expect(intentOf("computer_desktop_launch", undefined)).toBe("write");
    const never = (candidate: ApprovalCandidate) =>
      refusedOutright({
        candidate,
        team: [],
        personal: [],
        customRulesEnabled: true,
        hostCommandsCap: "never",
      })?.reason;
    // The same refusal a command on the owner's machine gets.
    const command = never({
      actorId: OWNER,
      botId: "bot",
      toolRef: "computer_run_command",
      effect: "write",
      scope: "ls",
      args: { command: "ls" },
      subject: { runner: true, command: "ls" },
    });
    expect(command).toBe(HOST_COMMANDS_NEVER);
    const h = harness({ session: true, refusal: never });
    const error = await h.gateway
      .launchDesktopApp("bot", ACTOR, { app: "TextEdit" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionRefusedError);
    expect((error as Error).message).toBe(command as string);
    // Refused before the device was asked anything, and no card.
    expect(h.posts).toHaveLength(0);
    expect(h.cards).toHaveLength(0);
    expect(h.early.length).toBeGreaterThan(0);
    for (const candidate of h.early)
      expect(candidate.subject?.desktopWrite).toEqual({
        action: "launch",
        process: "TextEdit",
        session: "none",
      });
    expect(h.rows.at(-1)?.eventType).toBe("computer.action_refused");
    expect(h.payloads().at(-1)?.desktop).toMatchObject({
      action: "launch",
      process: "TextEdit",
    });

    // The cap of ask: asked inside the session too, as a command would be.
    const capped: Card[] = [];
    const ask = harness({
      session: true,
      write: () => ({ app: "TextEdit", durationMs: 9, delivery: "verified" }),
      gate: async (candidate) => {
        const outcome = await decideAction({
          team: [],
          personal: [],
          customRulesEnabled: true,
          autoReview: false,
          askBeforeChanges: true,
          hostCommandsCap: "ask",
          candidate,
        });
        if (outcome.behaviour === "allow") return undefined;
        capped.push({ candidate, outcome });
        return { complete: async () => undefined };
      },
    });
    const launched = await ask.gateway.launchDesktopApp("bot", ACTOR, {
      app: "TextEdit",
    });
    expect(capped).toHaveLength(1);
    expect(capped[0]?.outcome.source).toBe("host_command_cap");
    expect(capped[0]?.candidate.scope).toBe("desktop/TextEdit");
    expect(launched).toMatchObject({
      ok: true,
      app: "TextEdit",
      delivery: "verified",
    });
    // Without a cap, launching in the session is not asked about.
    const free = harness({
      session: true,
      write: () => ({ app: "TextEdit", durationMs: 9, delivery: "verified" }),
    });
    await free.gateway.launchDesktopApp("bot", ACTOR, { app: "TextEdit" });
    expect(free.cards).toHaveLength(0);
    expect(free.posts.at(-1)).toEqual({
      path: "/desktop/launch",
      payload: {
        session: free.token(),
        botId: "bot",
        actorId: OWNER,
        approved: false,
        actionWords: [...DEFAULT_DESKTOP_ACTION_WORDS],
        approvedTitle: "",
        app: "TextEdit",
      },
    });
    // A path or a flag is never sent: refused on the server, before any frame.
    for (const app of ["/bin/sh", "-x", "TextEdit -x", "../a", "C:\\x.exe"]) {
      const bad = harness({ session: true });
      await expect(
        bad.gateway.launchDesktopApp("bot", ACTOR, { app }),
      ).rejects.toThrow(DESKTOP_BAD_APP);
      expect(bad.posts).toHaveLength(0);
      expect(bad.gated).toHaveLength(0);
    }
  });

  test("wait on a window titled 银行 asks like a snapshot", async () => {
    const h = harness({
      windows: [NOTEPAD, WECHAT, BANK],
      write: (path, payload) => {
        expect(path).toBe("/desktop/wait");
        return waited(
          [NOTEPAD, BANK].find((w) => w.windowId === payload.windowId) ??
            NOTEPAD,
        );
      },
    });
    expect(intentOf("computer_desktop_wait", undefined)).toBe("read");
    const result = await h.gateway.waitDesktop("bot", ACTOR, {
      windowId: BANK.windowId,
      name: "登录",
      timeoutSec: 5,
    });
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]?.candidate.toolRef).toBe("computer_desktop_wait");
    expect(h.cards[0]?.candidate.subject?.desktop).toEqual({
      title: BANK.title,
      sensitiveWord: "银行",
    });
    expect(h.cards[0]?.outcome).toEqual({
      behaviour: "ask",
      source: "desktop_window",
      reason: desktopWindowReason(BANK.title, "银行"),
    });
    // The same card a snapshot of that window gets.
    await h.gateway.snapshotDesktop("bot", ACTOR, { windowId: BANK.windowId });
    expect(h.cards).toHaveLength(2);
    expect(h.cards[1]?.outcome).toEqual(h.cards[0]?.outcome as never);
    // Only an approved wait tells the device it may read the sensitive window.
    const waits = h.posts.filter((post) => post.path === "/desktop/wait");
    expect(waits[0]?.payload).toEqual({
      windowId: BANK.windowId,
      name: "登录",
      timeoutSec: 5,
      allowSensitive: true,
    });
    // Outside content, as a snapshot is; its controls are the ones a write names next.
    expect(result.untrusted).toContain("untrusted data");
    expect(result.elements).toEqual(waited(BANK).elements);
    // Given the whole wait, a command's budget each for the window list and the snapshot, room for
    // the queue, and never less than a snapshot's own backstop (round 1 of review).
    expect(
      h.timeouts.find((sent) => sent.path === "/desktop/wait")?.timeoutMs,
    ).toBe(
      Math.max(
        5_000 + 2 * DESKTOP_LIMITS.adCommandTimeoutMs + 10_000,
        DESKTOP_BACKSTOP_MS,
      ),
    );
    expect(DESKTOP_BACKSTOP_MS).toBe(90_000);
    // A plain title: no card, and the device is not told it may read a sensitive one.
    await h.gateway.waitDesktop("bot", ACTOR, {
      windowId: NOTEPAD.windowId,
      type: "button",
      timeoutSec: 30,
    });
    expect(h.cards).toHaveLength(2);
    expect(
      h.posts.filter((post) => post.path === "/desktop/wait").at(-1)?.payload,
    ).toEqual({
      windowId: NOTEPAD.windowId,
      type: "button",
      timeoutSec: 30,
      allowSensitive: false,
    });
    const row = h
      .payloads()
      .filter((payload) => payload.action === "computer_desktop_wait")
      .at(-1);
    expect(row?.desktop).toEqual({
      windowId: NOTEPAD.windowId,
      title: NOTEPAD.title,
      process: "notepad",
      screenshot: false,
    });
    // The control the wait showed is known to the writes: a click on it is no unknown control.
    const s = harness({
      session: true,
      write: (path) =>
        path === "/desktop/wait" ? waited(NOTEPAD) : { physical: false },
    });
    await s.gateway.waitDesktop("bot", ACTOR, {
      windowId: NOTEPAD.windowId,
      name: "登录",
      timeoutSec: 1,
    });
    await s.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-7:0" });
    expect(s.cards).toHaveLength(0);
    expect(s.posts.at(-1)?.payload).toMatchObject({ ref: "abc123-7:0" });
  });

  test("wait needs a name or a type", async () => {
    const h = harness();
    const wait = toolOf(h, "computer_desktop_wait");
    const windowId = NOTEPAD.windowId;
    for (const args of [
      { windowId, timeoutSec: 5 },
      { windowId, name: "x", timeoutSec: 0 },
      { windowId, name: "x", timeoutSec: 31 },
      { windowId, name: "x", timeoutSec: 1.5 },
      { windowId, name: "x".repeat(121), timeoutSec: 5 },
      { windowId, type: "x".repeat(61), timeoutSec: 5 },
      { windowId: "notepad", name: "x", timeoutSec: 5 },
      { windowId, name: "x", timeoutSec: 5, allowSensitive: true },
    ]) {
      const error = await wait.execute(args, {} as never).then(
        () => new Error(`accepted ${JSON.stringify(args)}`),
        (thrown: unknown) => thrown,
      );
      expect({ args, error: (error as Error).name }).toEqual({
        args,
        error: "ZodError",
      });
    }
    expect(h.posts).toHaveLength(0);
    // Called past the schema, the gateway refuses it before the device is asked anything.
    const error = await h.gateway
      .waitDesktop("bot", ACTOR, { windowId, timeoutSec: 5 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionRefusedError);
    expect((error as Error).message).toBe(DESKTOP_WAIT_TARGET);
    expect(h.posts).toHaveLength(0);
    expect(h.rows.at(-1)?.eventType).toBe("computer.action_refused");
    // A name alone, or a type alone, is enough.
    const g = harness({ write: () => waited(NOTEPAD) });
    const byName = toolOf(g, "computer_desktop_wait");
    await byName.execute(
      { windowId, name: "登录", timeoutSec: 1 },
      {} as never,
    );
    await byName.execute(
      { windowId, type: "button", timeoutSec: 30 },
      {} as never,
    );
    expect(g.paths().filter((path) => path === "/desktop/wait")).toHaveLength(
      2,
    );
  });

  test("writing the clipboard shows the text on the card and keeps only its length", async () => {
    const text = "复制的内容 SECRET-PASTE";
    const h = harness({ write: () => ({ bytes: 30, durationMs: 2 }) });
    const args = { text };
    const result = await withApprovalContext(
      { ...CONTINUATION(args), toolName: "computer_desktop_clipboard_write" },
      () => h.gateway.writeDesktopClipboard("bot", ACTOR, args),
    );
    expect(result).toEqual({ ok: true, bytes: 30 });
    expect(intentOf("computer_desktop_clipboard_write", undefined)).toBe(
      "write",
    );
    // One card, the session's; it carries the text in the call's own arguments.
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]?.candidate.args).toEqual(args);
    expect(h.cards[0]?.outcome.source).toBe("desktop_session");
    expect(h.posts.at(-1)).toMatchObject({
      path: "/desktop/clipboard_write",
      payload: { approved: true, text },
    });
    expect(JSON.stringify(h.rows)).not.toContain("SECRET-PASTE");
    const done = h.rows.find(
      (row) => row.eventType === "computer.desktop_write_done",
    );
    expect(done?.payload).toMatchObject({
      desktop: { action: "clipboard_write", textLength: text.length },
    });
    // Over 9 000 bytes: refused before any frame, with the length on the row.
    const g = harness({ session: true });
    await expect(
      g.gateway.writeDesktopClipboard("bot", ACTOR, {
        text: "中".repeat(3_001),
      }),
    ).rejects.toThrow(DESKTOP_TEXT_TOO_LONG);
    expect(g.posts).toHaveLength(0);
    expect(g.payloads().at(-1)?.desktop).toMatchObject({
      action: "clipboard_write",
      textLength: 3_001,
    });
  });
});

describe("round 1 of review (Task 25)", () => {
  const rule = (
    behaviour: ApprovalRule["behaviour"],
    toolRef: string,
  ): ApprovalRule => ({
    id: `rule-${behaviour}-${toolRef}`,
    ownerUserId: OWNER,
    botId: "*",
    toolRef,
    effect: "*",
    scope: "*",
    behaviour,
    revokedAt: null,
    createdAt: new Date(),
  });
  const waitCandidate: ApprovalCandidate = {
    actorId: OWNER,
    botId: "bot",
    toolRef: "computer_desktop_wait",
    effect: "read",
    scope: "desktop/notepad",
    args: {},
    subject: { runner: true, desktop: { title: NOTEPAD.title } },
  };
  const decide = (candidate: ApprovalCandidate, personal: ApprovalRule[]) =>
    decideAction({
      team: [],
      personal,
      customRulesEnabled: true,
      autoReview: false,
      askBeforeChanges: true,
      candidate,
    });

  test("the snapshot's rules govern the wait too, the stricter of the two; other tools are untouched", async () => {
    // Disabled: the wait is refused outright.
    expect(
      refusedOutright({
        candidate: waitCandidate,
        team: [],
        personal: [rule("deny", "computer_desktop_snapshot")],
        customRulesEnabled: true,
      }),
    ).toMatchObject({ behaviour: "deny", reason: TOOL_DISABLED });
    expect(
      await decide(waitCandidate, [rule("deny", "computer_desktop_snapshot")]),
    ).toMatchObject({ behaviour: "deny" });
    // Ask: the wait asks too, and the stricter rule wins either way round.
    expect(
      await decide(waitCandidate, [rule("ask", "computer_desktop_snapshot")]),
    ).toMatchObject({ behaviour: "ask", source: "personal_rule" });
    expect(
      await decide(waitCandidate, [
        rule("allow", "computer_desktop_wait"),
        rule("ask", "computer_desktop_snapshot"),
      ]),
    ).toMatchObject({ behaviour: "ask" });
    expect(
      await decide(waitCandidate, [
        rule("allow", "computer_desktop_snapshot"),
        rule("ask", "computer_desktop_wait"),
      ]),
    ).toMatchObject({ behaviour: "ask" });
    // With no rule, a plain window is read unasked.
    expect(await decide(waitCandidate, [])).toMatchObject({
      behaviour: "allow",
    });
    // A snapshot rule reaches no other tool: not the window list, not the browser's own read.
    for (const toolRef of ["computer_desktop_windows", "computer_snapshot"]) {
      const other = { ...waitCandidate, toolRef, scope: "desktop" };
      expect(
        refusedOutright({
          candidate: other,
          team: [],
          personal: [rule("deny", "computer_desktop_snapshot")],
          customRulesEnabled: true,
        }),
      ).toBeUndefined();
      expect(
        await decide(other, [rule("ask", "computer_desktop_snapshot")]),
      ).toMatchObject({ behaviour: "allow" });
    }
  });

  test("the gateway asks about the wait as a snapshot too: disabled there, it is refused before any frame", async () => {
    const h = harness({
      refusal: (candidate) =>
        candidate.toolRef === "computer_desktop_snapshot"
          ? TOOL_DISABLED
          : undefined,
    });
    const error = await h.gateway
      .waitDesktop("bot", ACTOR, {
        windowId: NOTEPAD.windowId,
        name: "登录",
        timeoutSec: 5,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionRefusedError);
    expect((error as Error).message).toBe(TOOL_DISABLED);
    expect(h.posts).toHaveLength(0);
    expect(h.early.map((candidate) => candidate.toolRef)).toEqual([
      "computer_desktop_snapshot",
    ]);
    // Not disabled: both are asked, the snapshot first.
    const g = harness({ write: () => ({}) });
    await g.gateway.waitDesktop("bot", ACTOR, {
      windowId: NOTEPAD.windowId,
      name: "登录",
      timeoutSec: 5,
    });
    expect(g.early.map((candidate) => candidate.toolRef)).toEqual([
      "computer_desktop_snapshot",
      "computer_desktop_wait",
    ]);
  });

  test("with no approval policy, reading the clipboard is still asked on the server", async () => {
    const fixture = approvalFixture();
    const h = harness({
      session: true,
      gate: (candidate) => fixture.service.gate(candidate),
      write: () => ({ text: "x", truncated: false, durationMs: 1 }),
    });
    const context = {
      ...CONTINUATION({}),
      toolName: "computer_desktop_clipboard_read",
    };
    await expect(
      runAsTenant(OWNER, () =>
        withApprovalContext(context, () =>
          h.gateway.readDesktopClipboard("bot", ACTOR),
        ),
      ),
    ).rejects.toBeInstanceOf(HeadlessToolSuspension);
    expect(h.paths()).not.toContain("/desktop/clipboard_read");
    expect(fixture.rows.get("approval")?.action.toolRef).toBe(
      "computer_desktop_clipboard_read",
    );
  });
});

/*
 * The final whole-branch review (final-fix-brief.md): C1, I1 and I3 on the server. Each only asks
 * more; the device is still the last gate.
 */
describe("the final review", () => {
  afterEach(() => resetBrand());
  const SELF_REASON = "这是熊宝自己的界面或命令行窗口，操作前需要你先确认。";
  const TERMINAL: DesktopWindow = {
    windowId: "a1111111111111111",
    title: "zsh — 80×24",
    process: "Terminal",
    focused: true,
    minimized: false,
  };
  const CHROME: DesktopWindow = {
    windowId: "a2222222222222222",
    title: "待审批 - 熊宝数字员工 - Google Chrome",
    process: "Google Chrome",
    focused: true,
    minimized: false,
  };
  const policyFor = (
    write: Partial<NonNullable<ApprovalSubject["desktopWrite"]>>,
  ) =>
    desktopActionReason(
      {
        actorId: OWNER,
        botId: "bot",
        toolRef: "computer_desktop_key",
        effect: "write",
        scope: "desktop",
        args: {},
        subject: {
          runner: true,
          desktopWrite: {
            session: "active",
            action: "key",
            keys: "tab",
            ...write,
          },
        },
      },
      DEFAULT_DESKTOP_ACTION_WORDS,
    );

  test("C1: the product's own window or a terminal asks, by its process or by the product's name in its title", () => {
    for (const process of [
      "Terminal",
      "iTerm2",
      "powershell.exe",
      "WindowsTerminal.exe",
      "xiongbao-device",
      "熊宝数字员工 设备端",
      "XiongBao",
    ])
      for (const action of ["click", "type", "key", "focus"] as const)
        expect({
          process,
          action,
          reason: policyFor({
            action,
            title: "x",
            process,
            control: { type: "textfield", name: "x" },
          }),
        }).toEqual({ process, action, reason: SELF_REASON });
    expect(policyFor({ title: CHROME.title, process: "Google Chrome" })).toBe(
      SELF_REASON,
    );
    expect(policyFor({ title: "XiongBao Work", process: "Safari" })).toBe(
      SELF_REASON,
    );
    expect(policyFor({ title: "笔记.txt - 记事本", process: "notepad" })).toBe(
      undefined,
    );
    // The name is the deployment's brand, never one written into the server.
    setBrand({
      productName: "甲乙数字员工",
      shortName: "甲乙",
      englishName: "Jiayi",
    });
    expect(desktopSelfWindowWords()).toEqual(["甲乙数字员工", "甲乙", "Jiayi"]);
    expect(
      policyFor({ title: "审批 - 甲乙 - Chrome", process: "chrome" }),
    ).toBe("这是甲乙自己的界面或命令行窗口，操作前需要你先确认。");
    expect(policyFor({ title: CHROME.title, process: "chrome" })).toBe(
      undefined,
    );
    resetBrand();
    expect(desktopSelfWindowWords()).toEqual([
      "熊宝数字员工",
      "熊宝",
      "XiongBao Work",
    ]);
  });

  test("C1: in a session a key in a terminal is asked about, and the device is sent the product's names", async () => {
    const h = harness({ session: true, windows: [NOTEPAD, WECHAT, TERMINAL] });
    await h.gateway.pressDesktopKey("bot", ACTOR, {
      windowId: TERMINAL.windowId,
      keys: "l",
    });
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]?.outcome).toEqual({
      behaviour: "ask",
      source: "desktop_action",
      reason: SELF_REASON,
    });
    expect(lastWrite(h)).toMatchObject({
      approved: true,
      selfWindowWords: ["熊宝数字员工", "熊宝", "XiongBao Work"],
    });
    // A plain key in notepad is not asked about; the device still gets the names.
    await h.gateway.pressDesktopKey("bot", ACTOR, {
      windowId: NOTEPAD.windowId,
      keys: "ctrl+s",
    });
    expect(h.cards).toHaveLength(1);
    expect(lastWrite(h).selfWindowWords).toEqual([
      "熊宝数字员工",
      "熊宝",
      "XiongBao Work",
    ]);
    // A write with no window has no window words to check.
    await h.gateway.writeDesktopClipboard("bot", ACTOR, { text: "x" });
    expect(Object.keys(h.posts.at(-1)?.payload ?? {})).not.toContain(
      "selfWindowWords",
    );
  });

  test("C1: 允许一次 is asked about whatever the team's words", async () => {
    const decided = await decideAction({
      team: [],
      personal: [],
      customRulesEnabled: true,
      autoReview: false,
      askBeforeChanges: true,
      desktopActionWords: ["zzz"],
      candidate: {
        actorId: OWNER,
        botId: "bot",
        toolRef: "computer_desktop_click",
        effect: "write",
        scope: "desktop/chrome",
        args: {},
        subject: {
          runner: true,
          desktopWrite: {
            session: "active",
            action: "click",
            title: "Inbox",
            process: "chrome",
            control: { type: "button", name: "允许一次" },
          },
        },
      },
    });
    expect(decided).toMatchObject({
      behaviour: "ask",
      source: "desktop_action",
      reason:
        "在窗口「Inbox」里点击「允许一次」：控件名含「允许」，需要你批准。",
    });
  });

  test("I1: a click or a type tells the device the control's name the card showed, or null", async () => {
    const h = harness();
    await h.read();
    // Asked (opening the session): the card named 确定.
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" });
    expect(lastWrite(h)).toMatchObject({
      approved: true,
      approvedControlName: "确定",
    });
    // Let through in the session, unasked: none.
    await h.read();
    await h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" });
    expect(lastWrite(h)).toMatchObject({
      approved: false,
      approvedControlName: null,
    });
    await h.read();
    await h.gateway.typeDesktop("bot", ACTOR, {
      ref: "abc123-1:0",
      text: "a",
      mode: "append",
    });
    expect(lastWrite(h)).toMatchObject({ approvedControlName: null });
    // A card with no control on it (a ref this replica never saw): null, approved.
    const g = harness({ session: true });
    await g.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-9:1" });
    expect(lastWrite(g)).toMatchObject({
      approved: true,
      approvedControlName: null,
    });
    // A key or a focus names no control.
    await g.gateway.focusDesktopWindow("bot", ACTOR, {
      windowId: NOTEPAD.windowId,
    });
    expect(Object.keys(lastWrite(g))).not.toContain("approvedControlName");
  });

  test("I1: approved, and the device still asks: asked once more with its reason, sent under a key of its own", async () => {
    const reason = `控件名含「删除」：「发送${"x".repeat(120)}删除」`;
    const h = harness({
      session: true,
      journal: true,
      write: (_path, payload) => {
        if (payload.approvedReason !== reason)
          throw new DeviceActionError(needsOf(reason));
        return {
          physical: false,
          durationMs: 3,
          delivery: "verified",
          window: {
            windowId: NOTEPAD.windowId,
            title: NOTEPAD.title,
            process: "notepad",
          },
          note: "n",
        };
      },
    });
    await h.read(WECHAT.windowId);
    const click = () =>
      computerActionIdentity.run("call-i1", () =>
        h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-2:0" }),
      );
    const result = await click();
    expect(result.ok).toBe(true);
    // Asked about 发送 (the name as this server holds it), then the device's reason.
    expect(h.cards.map((card) => card.outcome.reason)).toEqual([
      "在窗口「微信」里点击「发送」：控件名含「发送」，需要你批准。",
      `设备端核对后认为这一步需要你批准：${reason.slice(0, DESKTOP_LIMITS.titleMax)}。`,
    ]);
    expect(h.writesPosted().map((post) => post.payload.approved)).toEqual([
      true,
      true,
    ]);
    expect(h.writesPosted()[1]?.payload).toMatchObject({
      approvedControlName: "发送",
      approvedReason: reason.slice(0, DESKTOP_LIMITS.titleMax),
    });
    expect(Object.keys(h.writesPosted()[0]?.payload ?? {})).not.toContain(
      "approvedReason",
    );
    expect(DESKTOP_APPROVED_AGAIN).toBe(":approved2");
    const keys = [
      JSON.stringify(["bot", "/desktop/click", "call-i1:approved"]),
      JSON.stringify(["bot", "/desktop/click", "call-i1:approved2"]),
    ];
    expect(
      h.keys.filter((sent) => sent.path === "/desktop/click").map((s) => s.key),
    ).toEqual(keys);
    // The same call again (a replay): the journal answers both keys, the device does nothing more.
    await h.read(WECHAT.windowId);
    const before = h.writesPosted().length;
    expect((await click()).ok).toBe(true);
    expect(h.writesPosted()).toHaveLength(before);
    expect(
      h.keys.filter((sent) => sent.path === "/desktop/click").map((s) => s.key),
    ).toEqual([...keys, ...keys]);
  });

  test("I1: asked again at most once per call, never in a loop", async () => {
    const asked = needsOf("窗口标题含「银行」");
    const h = harness({
      write: () => {
        throw new DeviceActionError(asked);
      },
    });
    await h.read();
    await expect(
      h.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" }),
    ).rejects.toThrow(asked);
    expect(h.cards).toHaveLength(2);
    expect(h.writesPosted()).toHaveLength(2);
    // Unapproved first, then the device asked: one card, as before, and no third send.
    const g = harness({
      session: true,
      write: () => {
        throw new DeviceActionError(asked);
      },
    });
    await g.read();
    await expect(
      g.gateway.clickDesktop("bot", ACTOR, { ref: "abc123-1:1" }),
    ).rejects.toThrow(asked);
    expect(g.cards).toHaveLength(1);
    expect(g.writesPosted().map((post) => post.payload.approved)).toEqual([
      false,
      true,
    ]);
  });

  test("I3: deleting at once is asked about on the server too, with its own words", async () => {
    const h = harness({ session: true });
    for (const keys of ["shift+delete", "cmd+backspace", "cmd+alt+backspace"]) {
      await h.gateway.pressDesktopKey("bot", ACTOR, {
        windowId: NOTEPAD.windowId,
        keys,
      });
      expect(h.cards.at(-1)?.outcome).toEqual({
        behaviour: "ask",
        source: "desktop_action",
        reason: `在窗口「${NOTEPAD.title}」里按 ${keys}，可能会直接删除文件或内容，需要你批准。`,
      });
    }
    expect(h.cards).toHaveLength(3);
  });
});

const needsOf = (reason: string) => desktopMessage("needs_approval", reason);

/*
 * The final review, round 2 (Important-1, Important-2): the card asked again after an approval is an
 * action of its own, and the approval's own run (`resume`) is the path every approval takes.
 */
describe("the final review, round 2", () => {
  const TERMINAL: DesktopWindow = {
    windowId: "a1111111111111111",
    title: "zsh — 80×24",
    process: "Terminal",
    focused: true,
    minimized: false,
  };
  const SELF_DEVICE = "这是熊宝自己的界面或命令行窗口，操作前需要你先确认";

  /**
   * An in-memory approval store whose requests start pending. `onePerCall` keeps the production
   * store's rule (approval_requests_action_idx: one request per person, run and tool call, and the
   * same action); without it, every distinct action of a call gets a request of its own.
   */
  function approvals(options: { onePerCall: boolean }) {
    const rows = new Map<string, ApprovalRecord>();
    let next = 0;
    const store: ApprovalStore = {
      enabled: async () => true,
      setEnabled: async () => {},
      open: async (value) => {
        const prior = [...rows.values()].find(
          (row) =>
            row.action.runId === value.runId &&
            row.action.toolCallId === value.toolCallId &&
            (options.onePerCall ||
              row.action.actionDigest === value.actionDigest),
        );
        if (prior) {
          if (prior.action.actionDigest !== value.actionDigest)
            throw new ApprovalRefusedError("The approved action has changed.");
          return structuredClone(prior);
        }
        next += 1;
        const row = {
          id: `approval-${next}`,
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
        rows.set(row.id, row);
        return structuredClone(row);
      },
      get: async (_owner, id) =>
        structuredClone(rows.get(id) as ApprovalRecord),
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

  /** The owner answers request `id`, then the server carries it out as the resume sweep does. */
  async function answer(
    fixture: ReturnType<typeof approvals>,
    id: string,
    approve: boolean,
    tool: () => Promise<unknown>,
  ) {
    const row = fixture.rows.get(id) as ApprovalRecord;
    expect(row.status).toBe("pending");
    row.status = approve ? "approved" : "denied";
    (row as { decision: string }).decision = approve ? "allow_once" : "deny";
    await fixture.service.resume(OWNER, id, {
      validate: (action: ApprovalRecord["action"]) =>
        fixture.service.validateReentry(action, tool),
      execute: () => tool(),
      continue: async () => {},
    } as never);
    return fixture.rows.get(id) as ApprovalRecord;
  }

  /**
   * A device that asks with `reason` until it is sent the owner's approval of that very reason, as
   * the runner does (runner/tests/ad-write.test.ts, round 2), and counts what it carried out.
   */
  function scenario(options: {
    onePerCall?: boolean;
    session: boolean;
    reason: string;
    windows?: DesktopWindow[];
  }) {
    const fixture = approvals({ onePerCall: options.onePerCall === true });
    let carriedOut = 0;
    const h = harness({
      session: options.session,
      journal: true,
      ...(options.windows ? { windows: options.windows } : {}),
      gate: (candidate) => fixture.service.gate(candidate),
      write: (_path, payload) => {
        if (payload.approvedReason !== options.reason)
          throw new DeviceActionError(needsOf(options.reason));
        carriedOut += 1;
        return {
          physical: false,
          durationMs: 3,
          delivery: "verified",
          window: {
            windowId: WECHAT.windowId,
            title: WECHAT.title,
            process: "wechat",
          },
          note: "n",
        };
      },
    });
    return { fixture, h, carriedOut: () => carriedOut };
  }

  const inCall = (
    toolName: string,
    args: Record<string, unknown>,
    write: () => Promise<unknown>,
  ) =>
    withApprovalContext(
      { ...CONTINUATION(args), toolCallId: "call-r2", toolName },
      () => computerActionIdentity.run("call-r2", write),
    );

  const clickKeys = (h: ReturnType<typeof harness>) =>
    h.keys.filter((sent) => sent.path === "/desktop/click").map((s) => s.key);

  test("Important-1 (a, b): in a session, approved, then the device asks: a second card opens, and only its approval carries the write out, once", async () => {
    await runAsTenant(OWNER, async () => {
      const reason = `控件名含「删除」：「发送${"x".repeat(120)}删除」`;
      const { fixture, h, carriedOut } = scenario({ session: true, reason });
      await h.read(WECHAT.windowId);
      const args = { ref: "abc123-2:0" };
      const click = () =>
        inCall("computer_desktop_click", args, () =>
          h.gateway.clickDesktop("bot", ACTOR, args),
        );
      await expect(click()).rejects.toBeInstanceOf(HeadlessToolSuspension);
      expect([...fixture.rows.keys()]).toEqual(["approval-1"]);

      // The first card approved and carried out: the device asks, and the call waits on a second card.
      await h.read(WECHAT.windowId);
      const first = await answer(fixture, "approval-1", true, click);
      expect(first.result).toEqual({
        content: "This action is waiting for your approval.",
        error: "This action is waiting for your approval.",
      });
      expect(carriedOut()).toBe(0);
      const second = fixture.rows.get("approval-2") as ApprovalRecord;
      expect(second.status).toBe("pending");
      expect(second.action.actionDigest).not.toBe(first.action.actionDigest);
      expect((second.action.target as Record<string, unknown>).reasked).toBe(
        reason.slice(0, DESKTOP_LIMITS.titleMax),
      );
      expect(clickKeys(h)).toEqual([
        JSON.stringify(["bot", "/desktop/click", "call-r2:approved"]),
      ]);

      // The second approved and carried out: sent with its reason, under its own key, once.
      await h.read(WECHAT.windowId);
      const done = await answer(fixture, "approval-2", true, click);
      // No `error` beside the content: toEqual fails on a defined property it was not given.
      expect(done.result).toEqual({ content: expect.any(String) });
      expect(carriedOut()).toBe(1);
      expect(clickKeys(h)).toEqual([
        JSON.stringify(["bot", "/desktop/click", "call-r2:approved"]),
        JSON.stringify(["bot", "/desktop/click", "call-r2:approved2"]),
      ]);
      expect(h.writesPosted().at(-1)?.payload).toMatchObject({
        approved: true,
        approvedReason: reason.slice(0, DESKTOP_LIMITS.titleMax),
        approvedControlName: "发送",
        approvedProcess: "wechat",
      });
      expect(fixture.rows.size).toBe(2);
    });
  });

  test("Important-1 (c): the second card declined, nothing is carried out", async () => {
    await runAsTenant(OWNER, async () => {
      const reason = "控件名含「删除」：「发送…删除」";
      const { fixture, h, carriedOut } = scenario({ session: true, reason });
      await h.read(WECHAT.windowId);
      const args = { ref: "abc123-2:0" };
      const click = () =>
        inCall("computer_desktop_click", args, () =>
          h.gateway.clickDesktop("bot", ACTOR, args),
        );
      await expect(click()).rejects.toBeInstanceOf(HeadlessToolSuspension);
      await h.read(WECHAT.windowId);
      await answer(fixture, "approval-1", true, click);
      const sent = h.writesPosted().length;
      const declined = await answer(fixture, "approval-2", false, click);
      expect(declined.result?.error).toBeDefined();
      expect(carriedOut()).toBe(0);
      expect(h.writesPosted()).toHaveLength(sent);
      expect(fixture.rows.size).toBe(2);
    });
  });

  test("Important-1 (d): the first card opened the session; the second is asked in it, and carried out once", async () => {
    await runAsTenant(OWNER, async () => {
      const reason = "控件名含「删除」：「发送…删除」";
      const { fixture, h, carriedOut } = scenario({ session: false, reason });
      await h.read(WECHAT.windowId);
      const args = { ref: "abc123-2:0" };
      const click = () =>
        inCall("computer_desktop_click", args, () =>
          h.gateway.clickDesktop("bot", ACTOR, args),
        );
      await expect(click()).rejects.toBeInstanceOf(HeadlessToolSuspension);
      const opening = fixture.rows.get("approval-1") as ApprovalRecord;
      expect((opening.action.target as Record<string, unknown>).session).toBe(
        "none",
      );
      await h.read(WECHAT.windowId);
      await answer(fixture, "approval-1", true, click);
      expect(h.paths()).toContain("/desktop/session_start");
      expect(carriedOut()).toBe(0);
      const second = fixture.rows.get("approval-2") as ApprovalRecord;
      expect((second.action.target as Record<string, unknown>).session).toBe(
        "active",
      );
      await h.read(WECHAT.windowId);
      await answer(fixture, "approval-2", true, click);
      expect(carriedOut()).toBe(1);
      expect(
        h.paths().filter((path) => path === "/desktop/session_start"),
      ).toHaveLength(1);
    });
  });

  test("Important-1: with one request per tool call, as the production store keeps them, the device's ask is never carried out unasked", async () => {
    await runAsTenant(OWNER, async () => {
      const reason = "控件名含「删除」：「发送…删除」";
      const { fixture, h, carriedOut } = scenario({
        session: true,
        reason,
        onePerCall: true,
      });
      await h.read(WECHAT.windowId);
      const args = { ref: "abc123-2:0" };
      const click = () =>
        inCall("computer_desktop_click", args, () =>
          h.gateway.clickDesktop("bot", ACTOR, args),
        );
      await expect(click()).rejects.toBeInstanceOf(HeadlessToolSuspension);
      await h.read(WECHAT.windowId);
      const first = await answer(fixture, "approval-1", true, click);
      // The second card cannot be opened in the same call: refused, and nothing carried out. Round
      // 3: told in Chinese, with the model asked to call again (the store's English never reaches it).
      expect(first.result?.error).toBe(desktopCallAgain(reason));
      expect(carriedOut()).toBe(0);
      expect(fixture.rows.size).toBe(1);
      expect(clickKeys(h)).toEqual([
        JSON.stringify(["bot", "/desktop/click", "call-r2:approved"]),
      ]);
    });
  });

  test("Important-2: a card with no control, approved, then a new line typed in a terminal: asked again, carried out only on the second card", async () => {
    await runAsTenant(OWNER, async () => {
      const { fixture, h, carriedOut } = scenario({
        session: true,
        reason: SELF_DEVICE,
        windows: [NOTEPAD, WECHAT, TERMINAL],
      });
      // A ref this replica never saw: the card names no control, no window and no process.
      const args = { ref: "abc123-9:1", text: "rm -rf ~\n", mode: "append" };
      const type = () =>
        inCall("computer_desktop_type", args, () =>
          h.gateway.typeDesktop("bot", ACTOR, {
            ref: "abc123-9:1",
            text: "rm -rf ~\n",
            mode: "append",
          }),
        );
      await expect(type()).rejects.toBeInstanceOf(HeadlessToolSuspension);
      // The card names no control and no window.
      expect(
        (fixture.rows.get("approval-1") as ApprovalRecord).action.target,
      ).toEqual({
        session: "active",
        window: { windowId: "", title: "", process: "" },
        action: "type",
      });
      await answer(fixture, "approval-1", true, type);
      expect(carriedOut()).toBe(0);
      expect(h.writesPosted()[0]?.payload).toMatchObject({
        approved: true,
        approvedControlName: null,
        approvedProcess: null,
      });
      expect(
        (
          (fixture.rows.get("approval-2") as ApprovalRecord).action
            .target as Record<string, unknown>
        ).reasked,
      ).toBe(SELF_DEVICE);
      await answer(fixture, "approval-2", true, type);
      expect(carriedOut()).toBe(1);
      expect(h.writesPosted().at(-1)?.payload).toMatchObject({
        approvedReason: SELF_DEVICE,
      });
    });
  });
});

/*
 * The final review, round 3: production keeps one approval request per tool call, so what the device
 * found after an approval is kept here (this replica, ten minutes) and named on the next call's first
 * card, under that card's own approval.
 */
describe("the final review, round 3", () => {
  const REASON = `控件名含「删除」：「发送${"x".repeat(60)}删除」`;
  const CALL_AGAIN = `设备发现了确认卡上没写的情况：${REASON}。请再调用一次，下一张确认卡会写明，由主人重新确认。`;
  const OWN = "在窗口「微信」里点击「发送」：控件名含「发送」，需要你批准。";
  const SAID = `设备端上次核对时发现了确认卡上没写的情况：${REASON}。`;

  /**
   * The approval store as production keeps it: one request per person, run and tool call, and the
   * same action (approval_requests_action_idx); with a policy, so a card keeps the reason it gave.
   */
  function production(options: { task?: boolean } = {}) {
    const rows = new Map<string, ApprovalRecord>();
    let next = 0;
    const store = {
      enabled: async () => true,
      setEnabled: async () => {},
      // A task started from a check-in: every change asks, on a card with the task's words (round 4).
      ...(options.task ? { asksEveryChange: async () => true } : {}),
      open: async (value: ApprovalRecord["action"]) => {
        const prior = [...rows.values()].find(
          (row) =>
            row.action.runId === value.runId &&
            row.action.toolCallId === value.toolCallId,
        );
        if (prior) {
          if (prior.action.actionDigest !== value.actionDigest)
            throw new ApprovalRefusedError("The approved action has changed.");
          return structuredClone(prior);
        }
        next += 1;
        const row = {
          id: `approval-${next}`,
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
        rows.set(row.id, row);
        return structuredClone(row);
      },
      get: async (_owner: string, id: string) =>
        structuredClone(rows.get(id) as ApprovalRecord),
      list: async () => [...rows.values()],
      decide: async (_owner: string, id: string) =>
        structuredClone(rows.get(id) as ApprovalRecord),
      consume: async (_owner: string, id: string, digest: string) => {
        const row = rows.get(id) as ApprovalRecord;
        if (row.action.actionDigest !== digest || row.status !== "approved")
          return false;
        row.status = "consumed";
        return true;
      },
      saveResult: async (
        _owner: string,
        id: string,
        result: ApprovalRecord["result"],
      ) => {
        const row = rows.get(id) as ApprovalRecord;
        if (row.result) return false;
        row.result = structuredClone(result);
        return true;
      },
      finish: async (_owner: string, id: string) => {
        (rows.get(id) as ApprovalRecord).status = "completed";
      },
      rules: async () => [],
      revoke: async () => {},
      policy: {
        preferences: async () => ({ enabled: true, autoReview: false }),
        teamSettings: async () => ({ customRulesEnabled: true }),
        teamRules: async () => [],
        recordDecision: async () => {},
        findEquivalent: async () => undefined,
        conversationGrants: async () => [],
        withdrawPending: async () => [],
      },
    } as unknown as ApprovalStore;
    const service = createApprovalFixtureService(store);
    approvalFixtureModel(store);
    return { rows, service };
  }

  async function answer(
    fixture: ReturnType<typeof production>,
    id: string,
    approve: boolean,
    tool: () => Promise<unknown>,
  ) {
    const row = fixture.rows.get(id) as ApprovalRecord;
    expect(row.status).toBe("pending");
    row.status = approve ? "approved" : "denied";
    (row as { decision: string }).decision = approve ? "allow_once" : "deny";
    await fixture.service.resume(OWNER, id, {
      validate: (action: ApprovalRecord["action"]) =>
        fixture.service.validateReentry(action, tool),
      execute: () => tool(),
      continue: async () => {},
    } as never);
    return fixture.rows.get(id) as ApprovalRecord;
  }

  /** A device that asks with REASON until it is sent the owner's approval of it, as the runner does. */
  function scenario(
    options: { onePerCall?: boolean; now?: () => number; task?: boolean } = {},
  ) {
    const fixture = production(options.task ? { task: true } : {});
    let carriedOut = 0;
    const h = harness({
      session: true,
      journal: true,
      onePerCall: options.onePerCall !== false,
      ...(options.now ? { now: options.now } : {}),
      gate: (candidate) => fixture.service.gate(candidate),
      write: (_path, payload) => {
        const approved = payload.approvedReason;
        const seen = Array.isArray(approved) ? approved : [approved];
        if (!seen.includes(REASON))
          throw new DeviceActionError(needsOf(REASON));
        carriedOut += 1;
        return {
          physical: false,
          durationMs: 3,
          delivery: "verified",
          window: {
            windowId: WECHAT.windowId,
            title: WECHAT.title,
            process: "wechat",
          },
          note: "n",
        };
      },
    });
    const click =
      (call: string, ref = "abc123-2:0", gateway = h.gateway) =>
      () =>
        withApprovalContext(
          {
            ...CONTINUATION({ ref }),
            toolCallId: call,
            toolName: "computer_desktop_click",
          },
          () =>
            computerActionIdentity.run(call, () =>
              gateway.clickDesktop("bot", ACTOR, { ref }),
            ),
        );
    const reasonOf = (id: string) =>
      (fixture.rows.get(id) as ApprovalRecord).action.policy?.reason;
    /** The reason on the card a tool call opened. */
    const reasonOfCall = (call: string) =>
      [...fixture.rows.values()].find((row) => row.action.toolCallId === call)
        ?.action.policy?.reason;
    return {
      fixture,
      h,
      click,
      reasonOf,
      reasonOfCall,
      carriedOut: () => carriedOut,
    };
  }

  /** The first call: asked about 发送, approved, and the device still asks. */
  async function firstCall(t: ReturnType<typeof scenario>) {
    await t.h.read(WECHAT.windowId);
    await expect(t.click("call-1")()).rejects.toBeInstanceOf(
      HeadlessToolSuspension,
    );
    expect(t.reasonOf("approval-1")).toBe(OWN);
    await t.h.read(WECHAT.windowId);
    return answer(t.fixture, "approval-1", true, t.click("call-1"));
  }

  test("(a) approved, then the device asks: the call ends in Chinese, telling the model to call again, and nothing is carried out", async () => {
    await runAsTenant(OWNER, async () => {
      const t = scenario();
      const first = await firstCall(t);
      expect(first.result).toEqual({ content: CALL_AGAIN, error: CALL_AGAIN });
      expect(t.carriedOut()).toBe(0);
      // No second request was tried in this call.
      expect(t.fixture.rows.size).toBe(1);
    });
  });

  test("(b, e) called again: the first card names what the device found; approved, carried out once, and the reason is used up", async () => {
    await runAsTenant(OWNER, async () => {
      const t = scenario();
      await firstCall(t);
      await t.h.read(WECHAT.windowId);
      // A new tool call, the same write (the snapshot read again: another ref, the same control).
      await expect(t.click("call-2", "abc123-2:0")()).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      expect(t.reasonOf("approval-2")).toBe(`${OWN}${SAID}`);
      // Its own card: the same action identity a card without the reason would have had.
      expect(
        (t.fixture.rows.get("approval-2") as ApprovalRecord).action.target,
      ).not.toHaveProperty("reasked");
      await t.h.read(WECHAT.windowId);
      const done = await answer(
        t.fixture,
        "approval-2",
        true,
        t.click("call-2"),
      );
      expect(done.result).toEqual({ content: expect.any(String) });
      expect(t.carriedOut()).toBe(1);
      expect(t.h.writesPosted().at(-1)?.payload).toMatchObject({
        approved: true,
        approvedReason: REASON,
        approvedControlName: "发送",
        approvedTitle: "微信",
        approvedProcess: "wechat",
      });
      expect(
        t.h.keys.filter((sent) => sent.path === "/desktop/click").at(-1)?.key,
      ).toBe(JSON.stringify(["bot", "/desktop/click", "call-2:approved"]));

      // (e) Used once: the next call's card says only its own reason.
      await t.h.read(WECHAT.windowId);
      await expect(t.click("call-3")()).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      expect(t.reasonOf("approval-3")).toBe(OWN);
    });
  });

  test("(c) called again and declined: nothing is carried out", async () => {
    await runAsTenant(OWNER, async () => {
      const t = scenario();
      await firstCall(t);
      await t.h.read(WECHAT.windowId);
      await expect(t.click("call-2")()).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      const sent = t.h.writesPosted().length;
      const declined = await answer(
        t.fixture,
        "approval-2",
        false,
        t.click("call-2"),
      );
      expect(declined.result?.error).toBeDefined();
      expect(t.carriedOut()).toBe(0);
      expect(t.h.writesPosted()).toHaveLength(sent);
    });
  });

  test("(d) after ten minutes, or for another control or window, the old reason is not on the card", async () => {
    await runAsTenant(OWNER, async () => {
      let clock = 1_000_000;
      const t = scenario({ now: () => clock });
      await firstCall(t);
      // Another control in the same window: 归档 (in a session, not asked about at all).
      await t.h.read(WECHAT.windowId);
      await t
        .click("call-2", "abc123-2:1")()
        .catch(() => undefined);
      // Another window: notepad's 确定.
      await t.h.read(NOTEPAD.windowId);
      await t
        .click("call-3", "abc123-1:1")()
        .catch(() => undefined);
      for (const candidate of t.h.gated.slice(-2)) {
        const write = candidate.subject?.desktopWrite;
        expect(write).toBeDefined();
        expect(Object.keys(write ?? {})).not.toContain("rememberedReasons");
      }
      // Ten minutes on, the same write: its own reason only.
      clock += DESKTOP_REASONS_TTL_MS + 1;
      await t.h.read(WECHAT.windowId);
      await expect(t.click("call-4")()).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      expect(t.reasonOfCall("call-4")).toBe(OWN);
    });
  });

  test("(f) unapproved, the device asks, and the card asked in this call names it: that card's own run sends it, carried out once", async () => {
    await runAsTenant(OWNER, async () => {
      const t = scenario();
      await t.h.read(NOTEPAD.windowId);
      // In a session 确定 is not asked about by the server; the device asks.
      await expect(t.click("call-1", "abc123-1:1")()).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      expect(t.reasonOfCall("call-1")).toBe(
        `设备端核对后认为这一步需要你批准：${REASON}。`,
      );
      expect(t.carriedOut()).toBe(0);
      // Another call for the same write meanwhile: what the waiting card said is not put on its card.
      await t.h.read(NOTEPAD.windowId);
      const before = t.h.gated.length;
      await t
        .click("call-2", "abc123-1:1")()
        .catch(() => undefined);
      // Its first candidate: the write as the server sees it, before the device is asked.
      const other = t.h.gated[before];
      expect(other?.subject?.desktopWrite?.action).toBe("click");
      expect(Object.keys(other?.subject?.desktopWrite ?? {})).not.toContain(
        "rememberedReasons",
      );
      // The first card approved and run: sent with the reason it named, carried out once.
      await t.h.read(NOTEPAD.windowId);
      const done = await answer(
        t.fixture,
        [...t.fixture.rows.values()].find(
          (row) => row.action.toolCallId === "call-1",
        )?.id as string,
        true,
        t.click("call-1", "abc123-1:1"),
      );
      expect(done.result).toEqual({ content: expect.any(String) });
      expect(t.carriedOut()).toBe(1);
    });
  });

  test("the reasons kept are this replica's, ten minutes each, at most DESKTOP_REASONS_KEPT, the oldest dropped first", () => {
    let clock = 0;
    const memory = createDesktopReasonMemory({ now: () => clock, max: 2 });
    memory.remember("a", ["1"]);
    memory.remember("b", ["2"]);
    memory.remember("c", ["3"]);
    expect(memory.recall("a")).toBeUndefined();
    expect(memory.recall("b")).toEqual({ reasons: ["2"] });
    expect(memory.recall("c")).toEqual({ reasons: ["3"] });
    clock = DESKTOP_REASONS_TTL_MS + 1;
    expect(memory.recall("c")).toBeUndefined();
    expect(DESKTOP_REASONS_TTL_MS).toBe(600_000);
    expect(DESKTOP_REASONS_KEPT).toBe(500);
  });

  test("without the one-request switch, the store's refusal of a second request is taken the same way", async () => {
    await runAsTenant(OWNER, async () => {
      const t = scenario({ onePerCall: false });
      const first = await firstCall(t);
      // A second request was tried, refused by the store: told as above, in Chinese.
      expect(first.result).toEqual({ content: CALL_AGAIN, error: CALL_AGAIN });
      expect(t.carriedOut()).toBe(0);
      expect(t.fixture.rows.size).toBe(1);
      // And kept for the next call all the same.
      await t.h.read(WECHAT.windowId);
      await expect(t.click("call-2")()).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      expect(t.reasonOf("approval-2")).toBe(`${OWN}${SAID}`);
    });
  });

  /*
   * ROUND 4: the device is only ever sent the reasons the approved request kept with its card
   * (`policy.deviceReasons`), in its own run (`resume`, on any replica) and replayed in a run alike;
   * what this replica remembers is only put on the next card.
   */
  describe("round 4: the reasons sent are the approved request's own", () => {
    const clicks = (h: ReturnType<typeof harness>) =>
      h.writesPosted().filter((post) => post.path === "/desktop/click");
    const idOf = (t: ReturnType<typeof scenario>, call: string) =>
      [...t.fixture.rows.values()].find((row) => row.action.toolCallId === call)
        ?.id as string;

    test("approved, the device asks: told in Chinese, nothing carried out; the retry's card names it, keeps it, and is carried out once", async () => {
      await runAsTenant(OWNER, async () => {
        const t = scenario();
        const first = await firstCall(t);
        expect(first.result?.error).toBe(CALL_AGAIN);
        expect(t.carriedOut()).toBe(0);
        expect(t.fixture.rows.size).toBe(1);
        await t.h.read(WECHAT.windowId);
        await expect(t.click("call-2")()).rejects.toBeInstanceOf(
          HeadlessToolSuspension,
        );
        const retry = t.fixture.rows.get("approval-2") as ApprovalRecord;
        expect(retry.action.policy?.reason).toBe(`${OWN}${SAID}`);
        expect(retry.action.policy?.deviceReasons).toEqual([REASON]);
        expect(t.carriedOut()).toBe(0);
        await t.h.read(WECHAT.windowId);
        const done = await answer(
          t.fixture,
          "approval-2",
          true,
          t.click("call-2"),
        );
        expect(done.result).toEqual({ content: expect.any(String) });
        expect(t.carriedOut()).toBe(1);
        expect(
          clicks(t.h).map((post) => [
            post.payload.approved,
            post.payload.approvedReason ?? null,
          ]),
        ).toEqual([
          [true, null],
          [true, REASON],
        ]);
      });
    });

    test("the retry's card declined: nothing is carried out", async () => {
      await runAsTenant(OWNER, async () => {
        const t = scenario();
        await firstCall(t);
        await t.h.read(WECHAT.windowId);
        await expect(t.click("call-2")()).rejects.toBeInstanceOf(
          HeadlessToolSuspension,
        );
        const before = clicks(t.h).length;
        await answer(t.fixture, "approval-2", false, t.click("call-2"));
        expect(t.carriedOut()).toBe(0);
        expect(clicks(t.h)).toHaveLength(before);
      });
    });

    /** A card opened before the device found anything, then another call that makes it remembered. */
    async function cardWithoutTheReason(t: ReturnType<typeof scenario>) {
      await t.h.read(WECHAT.windowId);
      await expect(t.click("call-X")()).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      const card = t.fixture.rows.get(idOf(t, "call-X")) as ApprovalRecord;
      expect(card.action.policy?.reason).toBe(OWN);
      expect(card.action.policy).not.toHaveProperty("deviceReasons");
      await t.h.read(WECHAT.windowId);
      await expect(t.click("call-1")()).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      await t.h.read(WECHAT.windowId);
      const told = await answer(
        t.fixture,
        idOf(t, "call-1"),
        true,
        t.click("call-1"),
      );
      expect(told.result?.error).toBe(CALL_AGAIN);
      expect(t.carriedOut()).toBe(0);
      return card;
    }

    test("a card that did not name the reason, approved and carried out by its own run: the reason is not sent", async () => {
      await runAsTenant(OWNER, async () => {
        const t = scenario();
        const card = await cardWithoutTheReason(t);
        await t.h.read(WECHAT.windowId);
        const done = await answer(t.fixture, card.id, true, t.click("call-X"));
        expect(done.result?.error).toBe(CALL_AGAIN);
        expect(t.carriedOut()).toBe(0);
        expect(
          clicks(t.h).map((post) => post.payload.approvedReason ?? null),
        ).toEqual([null, null]);
      });
    });

    test("a card that did not name the reason, approved and replayed in the run (the gate's permit): the reason is not sent, nothing carried out", async () => {
      await runAsTenant(OWNER, async () => {
        const t = scenario();
        const card = await cardWithoutTheReason(t);
        const row = t.fixture.rows.get(card.id) as ApprovalRecord;
        row.status = "approved";
        (row as { decision: string }).decision = "allow_once";
        await t.h.read(WECHAT.windowId);
        const replayed = t.click("call-X")();
        await expect(replayed).rejects.toBeInstanceOf(ActionRefusedError);
        await expect(replayed).rejects.toThrow(CALL_AGAIN);
        expect(t.carriedOut()).toBe(0);
        const last = clicks(t.h).at(-1)?.payload;
        expect(last?.approved).toBe(true);
        expect(Object.keys(last ?? {})).not.toContain("approvedReason");
      });
    });

    test("the retry's card approved eleven minutes on, when this replica no longer remembers: carried out once, the first time", async () => {
      await runAsTenant(OWNER, async () => {
        let clock = 1_000_000;
        const t = scenario({ now: () => clock });
        await firstCall(t);
        await t.h.read(WECHAT.windowId);
        await expect(t.click("call-2")()).rejects.toBeInstanceOf(
          HeadlessToolSuspension,
        );
        expect(t.reasonOfCall("call-2")).toBe(`${OWN}${SAID}`);
        clock += DESKTOP_REASONS_TTL_MS + 60_000;
        await t.h.read(WECHAT.windowId);
        const done = await answer(
          t.fixture,
          idOf(t, "call-2"),
          true,
          t.click("call-2"),
        );
        expect(done.result).toEqual({ content: expect.any(String) });
        expect(t.carriedOut()).toBe(1);
      });
    });

    test("the retry's card carried out by another replica, which remembers nothing: carried out once", async () => {
      await runAsTenant(OWNER, async () => {
        const t = scenario();
        await firstCall(t);
        await t.h.read(WECHAT.windowId);
        await expect(t.click("call-2")()).rejects.toBeInstanceOf(
          HeadlessToolSuspension,
        );
        expect(t.reasonOfCall("call-2")).toBe(`${OWN}${SAID}`);
        // Another replica: no reasons remembered, no controls read.
        const other = t.h.replica();
        const done = await answer(
          t.fixture,
          idOf(t, "call-2"),
          true,
          t.click("call-2", "abc123-2:0", other),
        );
        expect(done.result).toEqual({ content: expect.any(String) });
        expect(t.carriedOut()).toBe(1);
        expect(clicks(t.h).at(-1)?.payload).toMatchObject({
          approved: true,
          approvedReason: REASON,
          approvedControlName: "发送",
        });
      });
    });

    test("unapproved, the device asks, and the card asked in this call is carried out by another replica: sent with what that card kept, once", async () => {
      await runAsTenant(OWNER, async () => {
        const t = scenario();
        await t.h.read(NOTEPAD.windowId);
        await expect(t.click("call-1", "abc123-1:1")()).rejects.toBeInstanceOf(
          HeadlessToolSuspension,
        );
        const card = t.fixture.rows.get(idOf(t, "call-1")) as ApprovalRecord;
        expect(card.action.policy?.reason).toBe(
          `设备端核对后认为这一步需要你批准：${REASON}。`,
        );
        expect(card.action.policy?.deviceReasons).toEqual([REASON]);
        const done = await answer(
          t.fixture,
          card.id,
          true,
          t.click("call-1", "abc123-1:1", t.h.replica()),
        );
        expect(done.result).toEqual({ content: expect.any(String) });
        expect(t.carriedOut()).toBe(1);
      });
    });

    test("in a task started from a check-in, the retry's card says the task's words and the reason after them, and is carried out once", async () => {
      await runAsTenant(OWNER, async () => {
        const t = scenario({ task: true });
        const first = await firstTaskCall(t);
        expect(first.result?.error).toBe(CALL_AGAIN);
        expect(t.carriedOut()).toBe(0);
        await t.h.read(WECHAT.windowId);
        await expect(t.click("call-2")()).rejects.toBeInstanceOf(
          HeadlessToolSuspension,
        );
        const retry = t.fixture.rows.get(idOf(t, "call-2")) as ApprovalRecord;
        expect(retry.action.policy?.source).toBe("task");
        expect(retry.action.policy?.reason).toBe(`${TASK_ASKS} ${SAID}`);
        expect(retry.action.policy?.deviceReasons).toEqual([REASON]);
        await t.h.read(WECHAT.windowId);
        const done = await answer(t.fixture, retry.id, true, t.click("call-2"));
        expect(done.result).toEqual({ content: expect.any(String) });
        expect(t.carriedOut()).toBe(1);
      });
    });

    /** The first call in a task: its card has the task's words only. */
    async function firstTaskCall(t: ReturnType<typeof scenario>) {
      await t.h.read(WECHAT.windowId);
      await expect(t.click("call-1")()).rejects.toBeInstanceOf(
        HeadlessToolSuspension,
      );
      expect(t.reasonOf("approval-1")).toBe(TASK_ASKS);
      await t.h.read(WECHAT.windowId);
      return answer(t.fixture, "approval-1", true, t.click("call-1"));
    }
  });
});
