import { describe, expect, test } from "bun:test";
import { desktopMessage } from "../../shared/desktop-control";
import {
  DESKTOP_SESSION_REASON,
  DESKTOP_SESSION_TOOL,
  desktopSessionFloor,
} from "../src/approvals/desktop-policy";
import { decideAction, type ReviewModel } from "../src/approvals/policy";
import type {
  ApprovalCandidate,
  ApprovalPolicyOutcome,
  ApprovalRule,
  ApprovalSubject,
  ApprovalTeamRule,
} from "../src/approvals/types";
import { ApprovalRefusedError } from "../src/approvals/types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { DeviceActionError, runnerAddress } from "../src/devices/channel";
import type { DeviceStore } from "../src/devices/store";
import { runnerMessage } from "../src/devices/socket";
import {
  createDesktopSessionCache,
  desktopSessionKey,
  mintDesktopSessionToken,
} from "../src/computer/desktop-session";
import {
  createDesktopStoppedHandler,
  createDesktopWriteGate,
  DESKTOP_WRITE_OLD_RUNNER,
  type DesktopWriteGovern,
  type DesktopWritePost,
} from "../src/computer/desktop-write";
import {
  DESKTOP_OWNER_ONLY,
  DESKTOP_UNAVAILABLE_RULE,
} from "../src/computer/desktop-gateway";
import { ActionRefusedError } from "../src/computer/gateway";
import { currentTenant } from "../src/tenant/context";

/**
 * The server side of a desktop session (plan Task 16): the session floor in the approval policy, the
 * device-authoritative session token, and the one gate every desktop write goes through.
 */

const OWNER = "owner";
const ACTOR = { id: OWNER };
const MACHINE = { tenantId: OWNER, deviceId: "dev-1" };
const HEX64 = /[0-9a-f]{64}/;

const write = (
  over: Partial<NonNullable<ApprovalSubject["desktopWrite"]>> = {},
): NonNullable<ApprovalSubject["desktopWrite"]> => ({
  session: "none",
  action: "click",
  title: "无标题 - 记事本",
  process: "notepad",
  control: { type: "Button", name: "确定" },
  ...over,
});
const candidate = (
  over: Partial<ApprovalCandidate> = {},
): ApprovalCandidate => ({
  actorId: OWNER,
  botId: "bot",
  toolRef: "computer_desktop_click",
  effect: "write",
  scope: "desktop/notepad",
  args: { windowId: "a0123456789abcdef", ref: "abc123-1:0" },
  subject: { runner: true, desktopWrite: write() },
  ...over,
});
const rule = (
  behaviour: ApprovalRule["behaviour"],
  over: Partial<ApprovalRule> = {},
): ApprovalRule => ({
  id: `rule-${behaviour}`,
  ownerUserId: OWNER,
  botId: "*",
  toolRef: "*",
  effect: "*",
  scope: "*",
  behaviour,
  revokedAt: null,
  createdAt: new Date(),
  ...over,
});
const team = (
  behaviour: ApprovalRule["behaviour"],
  over: Partial<ApprovalTeamRule> = {},
): ApprovalTeamRule => {
  const { ownerUserId: _owner, ...rest } = rule(
    behaviour,
    over as ApprovalRule,
  );
  return { ...rest, id: `team-${behaviour}`, createdBy: "admin", ...over };
};
const base = {
  team: [] as ApprovalTeamRule[],
  personal: [] as ApprovalRule[],
  customRulesEnabled: true,
  autoReview: false,
  askBeforeChanges: true,
};

describe("desktop session floor", () => {
  test("with no session a desktop write asks once only, naming the mouse", async () => {
    for (const askBeforeChanges of [true, false]) {
      const out = await decideAction({
        ...base,
        askBeforeChanges,
        candidate: candidate(),
      });
      expect(out).toMatchObject({
        behaviour: "ask",
        source: "desktop_session",
      });
      expect(out.reason).toContain("必要时会移动你的鼠标");
      expect(out.reason.startsWith(DESKTOP_SESSION_REASON)).toBe(true);
    }
    // An allow rule for the tool does not skip opening the session.
    const allowed = await decideAction({
      ...base,
      personal: [rule("allow", { toolRef: "computer_desktop_click" })],
      candidate: candidate(),
    });
    expect(allowed).toMatchObject({
      behaviour: "ask",
      source: "desktop_session",
      reason: DESKTOP_SESSION_REASON,
    });
  });

  test("in a session the ask-before-changes default lets a write through", async () => {
    const out = await decideAction({
      ...base,
      candidate: candidate({
        subject: { runner: true, desktopWrite: write({ session: "active" }) },
      }),
    });
    expect(out).toEqual({
      behaviour: "allow",
      source: "desktop_session",
      reason: "桌面会话进行中。",
    });
    // The reviewer's verdict stays on the outcome the session turned into an allow.
    const model: ReviewModel = async () =>
      JSON.stringify({
        verdict: "proceed",
        preApproved: false,
        reason: "看起来正常",
      });
    const reviewed = await decideAction({
      ...base,
      autoReview: true,
      model,
      candidate: candidate({
        subject: { runner: true, desktopWrite: write({ session: "active" }) },
      }),
    });
    expect(reviewed).toMatchObject({
      behaviour: "allow",
      source: "desktop_session",
      reason: "桌面会话进行中。",
      review: { verdict: "proceed", reason: "看起来正常" },
    });
    // A write that is not a desktop one keeps the default's ask.
    const other = await decideAction({
      ...base,
      candidate: candidate({ subject: { runner: true } }),
    });
    expect(other).toMatchObject({ behaviour: "ask", source: "default" });
  });

  test("in a session an explicit ask rule still asks; a team deny still refuses outright", async () => {
    const active = candidate({
      subject: { runner: true, desktopWrite: write({ session: "active" }) },
    });
    const asked = await decideAction({
      ...base,
      personal: [rule("ask", { toolRef: "computer_desktop_click" })],
      candidate: active,
    });
    expect(asked).toMatchObject({ behaviour: "ask", source: "personal_rule" });
    const teamAsked = await decideAction({
      ...base,
      team: [team("ask", { toolRef: "computer_desktop_click" })],
      candidate: active,
    });
    expect(teamAsked).toMatchObject({ behaviour: "ask", source: "team_rule" });
    for (const desktopWrite of [write({ session: "active" }), write()]) {
      const denied = await decideAction({
        ...base,
        team: [team("deny", { toolRef: "computer_desktop_click" })],
        candidate: candidate({ subject: { runner: true, desktopWrite } }),
      });
      expect(denied).toMatchObject({ behaviour: "deny", source: "team_rule" });
    }
  });

  test("desktopWrite in the model's args is ignored", async () => {
    // The model claims a session; the gateway's subject says there is none: still asked.
    const claimed = await decideAction({
      ...base,
      candidate: candidate({
        args: {
          windowId: "a0123456789abcdef",
          desktopWrite: { session: "active", action: "click" },
          subject: { desktopWrite: { session: "active" } },
        },
      }),
    });
    expect(claimed).toMatchObject({
      behaviour: "ask",
      source: "desktop_session",
    });
    // The model asks for a session floor on a tool the gateway gave no desktop subject: not a session.
    const noSubject = candidate({
      args: { desktopWrite: { session: "none", action: "click" } },
      subject: { runner: true },
    });
    expect(desktopSessionFloor(noSubject)).toBeUndefined();
    const out = await decideAction({
      ...base,
      askBeforeChanges: false,
      candidate: noSubject,
    });
    expect(out.behaviour).toBe("allow");
    // And args claiming an active session do not turn the default's ask into an allow.
    const activeArgs = await decideAction({
      ...base,
      candidate: candidate({
        args: { desktopWrite: { session: "active", action: "click" } },
        subject: { runner: true },
      }),
    });
    expect(activeArgs).toMatchObject({ behaviour: "ask", source: "default" });
  });
});

describe("desktop session cache", () => {
  test("a token is kept 15 minutes idle and 60 minutes in all", () => {
    let now = 0;
    const cache = createDesktopSessionCache({ now: () => now });
    cache.set("k", "t1");
    now = 899_999;
    expect(cache.get("k")).toBe("t1");
    now = 900_001;
    expect(cache.get("k")).toBeUndefined();
    now = 0;
    cache.set("k", "t2");
    for (now = 800_000; now < 3_600_000; now += 800_000) {
      cache.touch("k");
      expect(cache.get("k")).toBe("t2");
    }
    now = 3_600_001;
    cache.touch("k");
    expect(cache.get("k")).toBeUndefined();
    cache.set("k", "t3");
    cache.drop("k");
    expect(cache.get("k")).toBeUndefined();
  });

  test("a minted token is 64 hex characters, new each time", () => {
    const a = mintDesktopSessionToken();
    const b = mintDesktopSessionToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

type Posted = { path: string; payload: Record<string, unknown> };

/**
 * The gate with a `govern` that stands in for the gateway's: the deployment's policy is permissive,
 * the approval policy decides from the subject the gate hands it, and an ask is approved by the
 * person (recorded in `cards`). Rows are what the gateway would write.
 */
function harness(
  options: {
    owner?: string;
    status?: (call: number) => Record<string, unknown>;
    start?: () => void;
    /** Awaited before an ask is approved: the owner taking their time. */
    approve?: () => Promise<void>;
    /** Thrown by every post: an old runner, an offline machine. */
    postError?: Error;
    refusal?: (candidate: ApprovalCandidate) => string | undefined;
    sessions?: ReturnType<typeof createDesktopSessionCache>;
  } = {},
) {
  const posts: Posted[] = [];
  const cards: {
    candidate: ApprovalCandidate;
    outcome: ApprovalPolicyOutcome;
  }[] = [];
  const early: ApprovalCandidate[] = [];
  const rows: Record<string, unknown>[] = [];
  let statusCalls = 0;
  const sessions = options.sessions ?? createDesktopSessionCache();
  const post: DesktopWritePost = async <T>(
    botId: string,
    path: string,
    payload: unknown,
    _signal: AbortSignal | undefined,
    _timeoutMs: number,
    address: string,
  ): Promise<T> => {
    expect(botId).toBe("bot");
    expect(address).toBe(runnerAddress(MACHINE));
    posts.push({ path, payload: payload as Record<string, unknown> });
    if (options.postError) throw options.postError;
    if (path === "/desktop/session_status") {
      statusCalls += 1;
      return (options.status?.(statusCalls) ?? {
        writable: true,
        platform: "macos",
      }) as T;
    }
    if (path === "/desktop/session_start") {
      options.start?.();
      return { started: true } as T;
    }
    throw new Error(`unexpected path ${path}`);
  };
  const govern: DesktopWriteGovern = async (
    toolName,
    botId,
    actor,
    subject,
    run,
  ) => {
    if (subject.refusal) {
      rows.push({ action: toolName, refusal: subject.refusal });
      throw new ActionRefusedError(
        subject.refusal,
        subject.refusalRule ?? DESKTOP_UNAVAILABLE_RULE,
      );
    }
    const asked = candidate({
      botId,
      actorId: actor.id,
      toolRef: toolName,
      args: { windowId: subject.windowId, ref: subject.ref },
      subject: { runner: true, desktopWrite: subject.desktopWrite },
    });
    const outcome = await decideAction({ ...base, candidate: asked });
    if (outcome.behaviour === "deny" || outcome.behaviour === "hand_off") {
      rows.push({ action: toolName, refusal: outcome.reason });
      throw new ApprovalRefusedError(outcome.reason);
    }
    const approved = outcome.behaviour === "ask";
    if (approved) {
      cards.push({ candidate: asked, outcome });
      await options.approve?.();
    }
    rows.push({ action: toolName, attempt: true, outcome });
    try {
      return await run(approved);
    } catch (error) {
      rows.push({
        action: toolName,
        failure: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const gate = createDesktopWriteGate({
    resolveDevice: async () =>
      options.owner === undefined
        ? MACHINE
        : { tenantId: options.owner, deviceId: "dev-1" },
    approvalRefusal: async (asked) => {
      early.push(asked);
      return options.refusal?.(asked);
    },
    govern,
    post,
    sessions,
  });
  const sent: { session: string; approved: boolean }[] = [];
  const send =
    (fail?: Error) =>
    async (session: string, approved: boolean): Promise<{ done: true }> => {
      posts.push({ path: "/desktop/click", payload: { session } });
      sent.push({ session, approved });
      if (fail) throw fail;
      return { done: true };
    };
  const click = (fail?: Error) =>
    gate.run(
      "computer_desktop_click",
      "bot",
      ACTOR,
      {
        action: "click",
        windowId: "a0123456789abcdef",
        ref: "abc123-1:0",
        subject: {
          action: "click",
          title: "无标题 - 记事本",
          process: "notepad",
          control: { type: "Button", name: "确定" },
        },
      },
      send(fail),
    );
  const paths = () => posts.map((p) => p.path);
  const leaks = () =>
    JSON.stringify({ rows, cards: cards.map((c) => c.candidate), early });
  return {
    gate,
    posts,
    paths,
    cards,
    early,
    rows,
    sent,
    sessions,
    click,
    leaks,
  };
}

describe("desktop write gate", () => {
  test("the first write asks, then mints a 64-hex token and starts the session before sending", async () => {
    const h = harness();
    expect(await h.click()).toEqual({ done: true });
    expect(h.paths()).toEqual([
      "/desktop/session_status",
      "/desktop/session_start",
      "/desktop/click",
    ]);
    expect(h.posts[0]?.payload).toEqual({ botId: "bot", actorId: OWNER });
    const started = h.posts[1]?.payload as {
      token: string;
      botId: string;
      actorId: string;
    };
    expect(started.token).toMatch(/^[0-9a-f]{64}$/);
    expect(started).toEqual({
      token: started.token,
      botId: "bot",
      actorId: OWNER,
    });
    expect(h.sent).toEqual([{ session: started.token, approved: true }]);
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]?.outcome).toMatchObject({
      behaviour: "ask",
      source: "desktop_session",
    });
    expect(h.cards[0]?.outcome.reason.startsWith(DESKTOP_SESSION_REASON)).toBe(
      true,
    );
    expect(h.cards[0]?.candidate.subject?.desktopWrite?.session).toBe("none");
    // The token is never on a row, a card, or an early-refusal question.
    expect(h.leaks()).not.toMatch(HEX64);
    expect(h.leaks()).not.toContain(started.token);
  });

  test("a second write in the session sends at once with the same token, no card", async () => {
    let token = "";
    const h = harness({
      status: (call) =>
        call === 1
          ? { writable: true, platform: "macos" }
          : { writable: true, platform: "macos", session: { token } },
      start: () => undefined,
    });
    await h.click();
    token = String(h.posts[1]?.payload.token);
    expect(h.sessions.get(desktopSessionKey(MACHINE, "bot", OWNER))).toBe(
      token,
    );
    await h.click();
    expect(h.paths()).toEqual([
      "/desktop/session_status",
      "/desktop/session_start",
      "/desktop/click",
      "/desktop/session_status",
      "/desktop/click",
    ]);
    expect(h.sent).toEqual([
      { session: token, approved: true },
      { session: token, approved: false },
    ]);
    expect(h.cards).toHaveLength(1);
    expect(h.leaks()).not.toMatch(HEX64);
  });

  test("a replica that does not know the session asks the device and uses its token", async () => {
    const token = "ab".repeat(32);
    const h = harness({
      status: () => ({ writable: true, platform: "macos", session: { token } }),
    });
    await h.click();
    expect(h.paths()).toEqual(["/desktop/session_status", "/desktop/click"]);
    expect(h.sent).toEqual([{ session: token, approved: false }]);
    expect(h.cards).toHaveLength(0);
    expect(h.sessions.get(desktopSessionKey(MACHINE, "bot", OWNER))).toBe(
      token,
    );
    expect(h.leaks()).not.toContain(token);
  });

  test("a device token that is not a token is not used", async () => {
    const h = harness({
      status: () => ({
        writable: true,
        platform: "macos",
        session: { token: "not-a-token" },
      }),
    });
    await h.click();
    expect(h.paths()).toEqual([
      "/desktop/session_status",
      "/desktop/session_start",
      "/desktop/click",
    ]);
    expect(h.cards).toHaveLength(1);
  });

  test("a non-writable device is refused before any card", async () => {
    const linux = desktopMessage("read_only_linux");
    const h = harness({
      status: () => ({ writable: false, reason: linux, platform: "linux" }),
    });
    await expect(h.click()).rejects.toThrow(linux);
    expect(h.paths()).toEqual(["/desktop/session_status"]);
    expect(h.cards).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.rows).toEqual([
      { action: "computer_desktop_click", refusal: linux },
    ]);
  });

  test("a disabled desktop or tool is refused before the device is asked", async () => {
    for (const disabled of [DESKTOP_SESSION_TOOL, "computer_desktop_click"]) {
      const h = harness({
        refusal: (asked) =>
          asked.toolRef === disabled ? "这个工具已被禁用。" : undefined,
      });
      await expect(h.click()).rejects.toThrow("这个工具已被禁用。");
      expect(h.posts).toHaveLength(0);
      expect(h.cards).toHaveLength(0);
      expect(h.early.map((asked) => asked.toolRef)).toContain(disabled);
      for (const asked of h.early) {
        expect(asked.effect).toBe("write");
        expect(asked.subject?.runner).toBe(true);
      }
    }
  });

  test("a device that answers stopped drops the cache and the next write asks again", async () => {
    const stopped = desktopMessage("stopped");
    let token = "";
    const h = harness({
      status: (call) =>
        call === 2 && token
          ? { writable: true, platform: "macos", session: { token } }
          : { writable: true, platform: "macos" },
    });
    await h.click();
    token = String(h.posts[1]?.payload.token);
    const key = desktopSessionKey(MACHINE, "bot", OWNER);
    expect(h.sessions.get(key)).toBe(token);
    // The owner pressed stop; the device refuses the write with its own copy, passed on as it is.
    const error = await h
      .click(new DeviceActionError(stopped))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceActionError);
    expect((error as Error).message).toBe(stopped);
    expect((error as DeviceActionError).outcomeUnknown).toBe(false);
    expect(h.sessions.get(key)).toBeUndefined();
    // No new session was opened on the way.
    expect(
      h.paths().filter((p) => p === "/desktop/session_start"),
    ).toHaveLength(1);
    // The next write finds no session on the device and asks again.
    await h.click();
    expect(h.cards).toHaveLength(2);
    expect(h.paths().slice(-3)).toEqual([
      "/desktop/session_status",
      "/desktop/session_start",
      "/desktop/click",
    ]);
    for (const code of ["session_expired", "no_session"] as const) {
      const g = harness({
        status: () => ({
          writable: true,
          platform: "macos",
          session: { token: "cd".repeat(32) },
        }),
      });
      await expect(
        g.click(new DeviceActionError(desktopMessage(code))),
      ).rejects.toThrow(desktopMessage(code));
      expect(g.sessions.get(key)).toBeUndefined();
      expect(g.paths()).not.toContain("/desktop/session_start");
    }
    expect(h.leaks()).not.toMatch(HEX64);
  });

  test("a device whose guard is not ready refuses the session and nothing is sent", async () => {
    const unready = desktopMessage("guard_unready");
    const h = harness({
      start: () => {
        throw new DeviceActionError(unready);
      },
    });
    const error = await h.click().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionRefusedError);
    expect((error as Error).message).toBe(unready);
    expect((error as { outcomeUnknown?: unknown }).outcomeUnknown).toBeFalsy();
    expect(h.sent).toHaveLength(0);
    expect(h.paths()).toEqual([
      "/desktop/session_status",
      "/desktop/session_start",
    ]);
    expect(
      h.sessions.get(desktopSessionKey(MACHINE, "bot", OWNER)),
    ).toBeUndefined();
    expect(h.leaks()).not.toMatch(HEX64);
  });

  test("a session is never opened without an approval", async () => {
    // A gateway with no approval gate lets the write run unasked: the gate refuses to open a session.
    const h = harness();
    const sessions = createDesktopSessionCache();
    const gate = createDesktopWriteGate({
      resolveDevice: async () => MACHINE,
      approvalRefusal: async () => undefined,
      govern: (_tool, _bot, _actor, _subject, run) => run(false),
      post: (async (_bot: string, path: string) => {
        h.posts.push({ path, payload: {} });
        return { writable: true, platform: "macos" };
      }) as DesktopWritePost,
      sessions,
    });
    let sent = false;
    await expect(
      gate.run(
        "computer_desktop_click",
        "bot",
        ACTOR,
        { action: "click", subject: { action: "click" } },
        async () => {
          sent = true;
        },
      ),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    expect(sent).toBe(false);
    expect(h.paths()).toEqual(["/desktop/session_status"]);
  });

  test("two writes while a session is being opened ask once and share its token", async () => {
    let release: () => void = () => undefined;
    const approval = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ approve: () => approval });
    const first = h.click();
    const second = h.click();
    // Let both reach the device's status and the first reach its card.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.cards).toHaveLength(1);
    release();
    expect(await first).toEqual({ done: true });
    expect(await second).toEqual({ done: true });
    expect(h.cards).toHaveLength(1);
    const starts = h.posts.filter((p) => p.path === "/desktop/session_start");
    expect(starts).toHaveLength(1);
    const token = String(starts[0]?.payload.token);
    expect(h.sent).toEqual([
      { session: token, approved: true },
      { session: token, approved: false },
    ]);
    expect(h.leaks()).not.toMatch(HEX64);
  });

  test("a waiting write whose session was refused asks for itself", async () => {
    const unready = desktopMessage("guard_unready");
    let starts = 0;
    const h = harness({
      start: () => {
        starts += 1;
        if (starts === 1) throw new DeviceActionError(unready);
      },
    });
    const first = h.click().catch((e: unknown) => e);
    const second = h.click();
    expect(((await first) as Error).message).toBe(unready);
    expect(await second).toEqual({ done: true });
    expect(h.cards).toHaveLength(2);
    expect(starts).toBe(2);
    expect(h.sent).toHaveLength(1);
  });

  test("an old runner is a refusal, not a failure of the action", async () => {
    const h = harness({
      postError: new Error(
        'Nothing on this machine handles "desktop.session_status".',
      ),
    });
    const error = await h.click().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionRefusedError);
    expect((error as Error).message).toBe(DESKTOP_WRITE_OLD_RUNNER);
    expect(h.cards).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  test("someone other than the owner is refused and nothing is sent", async () => {
    const h = harness({ owner: "someone-else" });
    await expect(h.click()).rejects.toThrow(DESKTOP_OWNER_ONLY);
    // The owner check comes before anything else, the early refusal question included.
    expect(h.early).toHaveLength(0);
    expect(h.posts).toHaveLength(0);
    expect(h.cards).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  test("a heartbeat's desktopStopped drops the session and writes one audit row", async () => {
    const sessions = createDesktopSessionCache();
    const key = desktopSessionKey(MACHINE, "bot", OWNER);
    const token = mintDesktopSessionToken();
    sessions.set(key, token);
    const rows: AuditEventInput[] = [];
    const auditStore: AuditStore = {
      insert: async (row) => {
        // Filed in the machine owner's tenant, from the runner's credential.
        expect(currentTenant()).toBe(MACHINE.tenantId);
        rows.push(row);
      },
    };
    const onDesktopStopped = createDesktopStoppedHandler({
      sessions,
      auditStore,
    });
    const sentFrames: string[] = [];
    const ws = {
      data: { runner: { ...MACHINE, credentialVersion: 1 }, connection: "c1" },
      send: (value: string) => void sentFrames.push(value),
    };
    const store = {
      isCurrent: async () => true,
      heartbeat: async () => undefined,
    } as unknown as DeviceStore;
    const channel = {
      flush: async () => undefined,
    } as never;
    const beat = (desktopStopped?: unknown) =>
      runnerMessage(
        ws as never,
        store,
        channel,
        JSON.stringify({
          type: "heartbeat",
          roots: [],
          ...(desktopStopped ? { desktopStopped } : {}),
        }),
        undefined,
        { onDesktopStopped },
      );
    await beat({ botId: "bot", actorId: OWNER, reason: "hotkey", at: 1 });
    expect(sessions.get(key)).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "computer.action_refused",
      targetType: "computer",
      targetId: "bot",
      actorUserId: OWNER,
      payload: {
        action: DESKTOP_SESSION_TOOL,
        bot: "bot",
        actor: OWNER,
        device: "dev-1",
        reason: "用户已停止桌面操作",
        stoppedBy: "hotkey",
        decision: { allowed: false, carriedOut: false },
      },
    });
    expect(JSON.stringify(rows)).not.toMatch(HEX64);
    expect(sentFrames.map((f) => JSON.parse(f).type)).toEqual(["ack"]);
    // A plain beat, or one with a malformed stop, drops nothing and writes nothing.
    sessions.set(key, token);
    await beat();
    await beat({ botId: 7, actorId: OWNER, reason: "hotkey" });
    expect(sessions.get(key)).toBe(token);
    expect(rows).toHaveLength(1);
    // A stop method the server does not know is recorded as unknown, not as the device's text.
    await beat({ botId: "bot", actorId: OWNER, reason: "<script>", at: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[1]?.payload.stoppedBy).toBe("unknown");
    // A person other than the machine's owner is not written into the trail.
    await beat({ botId: "bot", actorId: "mallory", reason: "button", at: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[2]?.actorUserId).toBe(OWNER);
    expect(rows[2]?.payload).not.toHaveProperty("actor");
    expect(JSON.stringify(rows[2])).not.toContain("mallory");
  });
});
