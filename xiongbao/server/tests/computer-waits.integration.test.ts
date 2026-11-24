import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HeadlessToolSuspension } from "@xiongbao/toolkit/headless-tools";
import { and, eq } from "drizzle-orm";
import {
  type ApprovalContinuation,
  parseApprovalContinuation,
  withApprovalContext,
} from "../src/approvals/types";
import { PERSON_INITIATOR } from "../src/audit";
import { personSeat } from "../src/computer/computer-key";
import {
  type ComputerGateway,
  HumanHasControlError,
} from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import {
  createComputerWaitStore,
  createComputerWaitSweep,
  MAX_RESUME_ATTEMPTS,
} from "../src/computer/waits";
import { createDatabase } from "../src/db/client";
import { computerWaits, users } from "../src/db/schema";
import { createWaitResumer } from "../src/passwords/resume";
import { createSignInService } from "../src/passwords/service";
import { createMemoryPasswordStore } from "../src/passwords/store";
import type { SignInRequestRecord } from "../src/passwords/types";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A turn that asks a person at the computer waits for them in the tool, and one that outlasts the wait
 * is carried on when they answer (期九·三).
 *
 * The computer is a fake whose state the test moves the way a person at the browser would; everything
 * else is real: the three tools, the wait's database table and the sweep over it, the sign-in service
 * and its request. Each of the three tools is taken through the outcomes the spec names: the person
 * answers while the tool waits, the person cancels, the wait runs out and the person answers later.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const people: string[] = [];

afterAll(async () => {
  for (const id of people)
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, id)),
    );
  await database.$client.end();
});

async function person(label: string): Promise<string> {
  const id = `cw-${suite}-${label}`;
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email: `${id}@cw.test`, name: label }),
  );
  people.push(id);
  return id;
}

const BOT = "worker";
/** A password the person types, which must never be anywhere the Bot can read. */
const PASSWORD = "correct-horse-battery-staple";

/* ------------------------------------------------------------------------------------------------
 * The computer: takeover requests and the masked box, moved the way a person moves them.
 * ---------------------------------------------------------------------------------------------- */

type Handoff = {
  id: string;
  reason: string;
  status: "waiting" | "taken" | "completed" | "cancelled" | "expired";
  source: "model";
  createdAt: string;
  updatedAt: string;
  interruption?: string;
};

function fakeComputer() {
  const handoffs = new Map<string, Handoff>();
  let secret: string | undefined;
  let typed: string | undefined;
  let held = false;
  const snapshots: number[] = [];
  const state = (requestId?: string) => ({
    holder: held ? "human" : "bot",
    since: new Date().toISOString(),
    requested: [...handoffs.values()].some((h) => h.status === "waiting"),
    request: requestId ? handoffs.get(requestId) : undefined,
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
    ...(secret ? { secretWanted: secret } : {}),
  });
  const gateway = {
    async seatFor(botId: string, personId: string) {
      return personSeat(personId, botId);
    },
    async requestHelp(
      _seat: unknown,
      _actor: unknown,
      reason: string,
      toolCallId?: string,
    ) {
      const id = `req-${toolCallId}`;
      const now = new Date().toISOString();
      handoffs.set(id, {
        id,
        reason,
        status: "waiting",
        source: "model",
        createdAt: now,
        updatedAt: now,
      });
      return state(id);
    },
    async requestSecret(
      _seat: unknown,
      _actor: unknown,
      input: { label: string },
    ) {
      secret = input.label;
      return state();
    },
    async control(_seat: unknown, requestId?: string) {
      return state(requestId);
    },
    async cancelControl(_seat: unknown, _actor: unknown, requestId: string) {
      const request = handoffs.get(requestId);
      if (request) request.status = "cancelled";
      return state(requestId);
    },
    async snapshot() {
      snapshots.push(Date.now());
      return { snapshotId: snapshots.length, elements: [] };
    },
    async click() {
      if (held) throw new HumanHasControlError("A person has control.");
      return { clicked: true };
    },
  };
  return {
    gateway: gateway as unknown as ComputerGateway,
    handoffs,
    snapshots,
    /** The person takes the wheel for a request, and later hands it back. */
    take: (id: string) => {
      const request = handoffs.get(id);
      if (request) request.status = "taken";
      held = true;
    },
    handBack: (id: string) => {
      const request = handoffs.get(id);
      if (request) request.status = "completed";
      held = false;
    },
    cancel: (id: string) => {
      const request = handoffs.get(id);
      if (request) request.status = "cancelled";
    },
    /** The person types the value into the box: the computer keeps it, and clears the request. */
    enter: (value: string) => {
      typed = value;
      secret = undefined;
    },
    get typed() {
      return typed;
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * A deployment's worth of wiring around one tenant.
 * ---------------------------------------------------------------------------------------------- */

const snapshotFor = (
  threadId: string,
  toolCallId: string,
  toolName: string,
): ApprovalContinuation =>
  parseApprovalContinuation({
    runId: `run-${suite}`,
    threadId,
    toolCallId,
    toolName,
    args: {},
    messages: [{ id: "u", role: "user", content: "do it" }],
    state: {},
    context: [],
    forwardedProps: {},
    initiator: { kind: "person" },
  });

type Resumed = { wait: string; content: string };

async function world(label: string, waits: { maxMs: number; pollMs: number }) {
  const tenant = await person(label);
  const computer = fakeComputer();
  const store = createComputerWaitStore(database, { graceMs: 0 });
  /*
   * The sweep looks at every tenant's waits, as it should; here the tests of one world share a database
   * with the others, so each world's store hands over only its own and gives the rest back untouched.
   */
  const claimDue = store.claimDue.bind(store);
  store.claimDue = async (input) => {
    const rows = await claimDue({ limit: 200 });
    for (const row of rows)
      if (row.ownerUserId !== tenant)
        await runAsTenant("platform", () => store.release(row.id));
    return rows
      .filter((row) => row.ownerUserId === tenant)
      .slice(0, input.limit);
  };
  const signInStore = createMemoryPasswordStore();
  const answered: SignInRequestRecord[] = [];
  const service = createSignInService({
    store: signInStore,
    gateway: computer.gateway as never,
    encryptionKey: "k".repeat(32),
    passwordManagerEnabled: async () => false,
    onResolved: async (request) => void answered.push(request),
  });
  const tools = createHeadlessComputerTools({
    gateway: computer.gateway,
    seat: personSeat(tenant, BOT),
    actor: { id: tenant, userId: tenant, initiator: PERSON_INITIATOR },
    signIn: service,
    waits: { store, ...waits },
  });
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.definition.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  /** One call of a tool, in the owner's frame and with the turn's continuation in scope, as a turn runs it. */
  const call = (
    name: string,
    args: unknown,
    toolCallId: string,
    signal: AbortSignal = new AbortController().signal,
  ) =>
    runAsTenant(tenant, () =>
      withApprovalContext(
        snapshotFor(`thread-${label}-${suite}`, toolCallId, name),
        () => tool(name).execute(args, { toolCallId, signal }),
      ),
    );
  const resumed: Resumed[] = [];
  const sweep = createComputerWaitSweep({
    store,
    gateway: computer.gateway as never,
    resume: async (wait, content) => {
      resumed.push({ wait: wait.id, content });
    },
    log: () => undefined,
  });
  const rows = () =>
    runAsTenant(tenant, () =>
      database
        .select()
        .from(computerWaits)
        .where(eq(computerWaits.ownerUserId, tenant)),
    );
  return {
    tenant,
    computer,
    store,
    service,
    signInStore,
    answered,
    call,
    resumed,
    sweep,
    rows,
  };
}

const later = (ms: number, then: () => void) =>
  setTimeout(() => {
    then();
  }, ms);

const asJson = (value: unknown) => JSON.stringify(value) as string;

const suspension = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    if (error instanceof HeadlessToolSuspension) return error;
    throw error;
  }
  throw new Error("the tool returned instead of stopping the turn");
};

/* ------------------------------------------------------------------------------------------------
 * 1. Take over
 * ---------------------------------------------------------------------------------------------- */

describe("computer_request_help waits for the person", () => {
  test("handed back while it waits: the tool returns the page as they left it, and the turn goes on", async () => {
    const w = await world("help-back", { maxMs: 5_000, pollMs: 10 });
    later(60, () => w.computer.take("req-h1"));
    later(120, () => w.computer.handBack("req-h1"));
    const result = (await w.call(
      "computer_request_help",
      { reason: "Clear the captcha" },
      "h1",
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.handoffStatus).toBe("completed");
    expect(String(result.result)).toContain("Clear the captcha");
    expect(w.computer.snapshots).toHaveLength(1);
    // Nothing was left on record: the turn was never stopped.
    expect(await w.rows()).toHaveLength(0);
  });

  test("cancelled while it waits: the tool says so, and the Bot is not told the person helped", async () => {
    const w = await world("help-cancel", { maxMs: 5_000, pollMs: 10 });
    later(60, () => w.computer.cancel("req-h2"));
    const result = (await w.call(
      "computer_request_help",
      { reason: "Sign in" },
      "h2",
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.handoffStatus).toBe("cancelled");
    expect(w.computer.snapshots).toHaveLength(0);
    expect(await w.rows()).toHaveLength(0);
  });

  test("the wait runs out, the person hands back later, and the server carries the turn on", async () => {
    const w = await world("help-late", { maxMs: 120, pollMs: 10 });
    const stopped = await suspension(
      w.call("computer_request_help", { reason: "Sign in" }, "h3"),
    );
    // Stopped as 「需要你」, naming the request and the wait that will carry it.
    expect(stopped.waiting.kind).toBe("computer_handoff");
    expect(stopped.waiting.requestId).toBe("req-h3");
    expect(typeof stopped.waiting.waitId).toBe("string");
    const [wait] = await w.rows();
    expect(wait?.id).toBe(stopped.waiting.waitId as string);
    expect(wait?.status).toBe("waiting");
    expect(wait?.kind).toBe("help");

    // The person still has it: the sweep leaves the wait alone, and does not count that as a try.
    w.computer.take("req-h3");
    await Promise.all(await w.sweep.tick());
    expect(w.resumed).toHaveLength(0);
    expect((await w.rows())[0]?.status).toBe("waiting");
    expect((await w.rows())[0]?.attempts).toBe(0);

    // They hand it back, and the turn is carried on, once, with the outcome as the tool's result.
    w.computer.handBack("req-h3");
    await Promise.all(await w.sweep.tick());
    expect(w.resumed).toHaveLength(1);
    const content = JSON.parse(w.resumed[0]?.content ?? "{}");
    expect(content.ok).toBe(true);
    expect(content.handoffStatus).toBe("completed");
    expect((await w.rows())[0]?.status).toBe("done");
    // Asked again: nothing more is carried on.
    await Promise.all(await w.sweep.tick());
    expect(w.resumed).toHaveLength(1);
  });

  test("cancelled after the wait ran out: the turn is carried on with the cancellation", async () => {
    const w = await world("help-late-cancel", { maxMs: 100, pollMs: 10 });
    await suspension(
      w.call("computer_request_help", { reason: "Sign in" }, "h4"),
    );
    w.computer.cancel("req-h4");
    await Promise.all(await w.sweep.tick());
    expect(w.resumed).toHaveLength(1);
    expect(JSON.parse(w.resumed[0]?.content ?? "{}")).toMatchObject({
      ok: false,
      handoffStatus: "cancelled",
    });
  });

  test("Stop ends the wait at once and withdraws a request nobody has taken", async () => {
    const w = await world("help-stop", { maxMs: 60_000, pollMs: 10 });
    const stop = new AbortController();
    later(80, () => stop.abort());
    const started = Date.now();
    const result = (await w.call(
      "computer_request_help",
      { reason: "Sign in" },
      "h5",
      stop.signal,
    )) as Record<string, unknown>;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.stopped).toBe(true);
    expect(w.computer.handoffs.get("req-h5")?.status).toBe("cancelled");
    expect(await w.rows()).toHaveLength(0);
  });

  test("a person who holds the wheel still has the Bot's own actions refused: the tool stops the turn, it does not act", async () => {
    const w = await world("help-held", { maxMs: 100, pollMs: 10 });
    w.computer.take("req-none");
    const stopped = await suspension(
      w.call("computer_click", { ref: "e1", snapshotId: 1 }, "k1"),
    );
    expect(stopped.waiting.kind).toBe("computer_handoff");
  });

  test("with the wait off, the tool stops the turn at once as it always did", async () => {
    const w = await world("help-off", { maxMs: 5_000, pollMs: 10 });
    const off = createHeadlessComputerTools({
      gateway: w.computer.gateway,
      seat: personSeat(w.tenant, BOT),
      actor: { id: w.tenant, userId: w.tenant, initiator: PERSON_INITIATOR },
      waits: false,
    }).find((tool) => tool.definition.name === "computer_request_help");
    const started = Date.now();
    const stopped = await suspension(
      runAsTenant(w.tenant, () =>
        Promise.resolve(
          off?.execute(
            { reason: "Sign in" },
            { toolCallId: "o1", signal: new AbortController().signal },
          ),
        ),
      ),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stopped.waiting.kind).toBe("computer_handoff");
    expect(await w.rows()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------------------------
 * 2. One value into a field
 * ---------------------------------------------------------------------------------------------- */

describe("computer_request_secret waits for the person", () => {
  const args = { label: "the code", ref: "e1", snapshotId: 1 };

  test("entered while it waits: the tool returns, and nothing it returns holds the value", async () => {
    const w = await world("secret-in", { maxMs: 5_000, pollMs: 10 });
    later(80, () => w.computer.enter(PASSWORD));
    const result = await w.call("computer_request_secret", args, "s1");
    expect(asJson(result)).toContain("has entered the code");
    // The value went from the person to the page, and is nowhere the Bot can read it.
    expect(w.computer.typed).toBe(PASSWORD);
    expect(asJson(result)).not.toContain(PASSWORD);
    expect(await w.rows()).toHaveLength(0);
  });

  test("Stop ends the wait: the Bot is told the request was cancelled", async () => {
    const w = await world("secret-stop", { maxMs: 60_000, pollMs: 10 });
    const stop = new AbortController();
    later(80, () => stop.abort());
    const started = Date.now();
    const result = (await w.call(
      "computer_request_secret",
      args,
      "s2",
      stop.signal,
    )) as Record<string, unknown>;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.result).toBe("The request was cancelled.");
    expect(await w.rows()).toHaveLength(0);
  });

  test("the wait runs out, the person enters it later, and the server carries the turn on", async () => {
    const w = await world("secret-late", { maxMs: 120, pollMs: 10 });
    const stopped = await suspension(
      w.call("computer_request_secret", args, "s3"),
    );
    expect(stopped.waiting.kind).toBe("computer_secret");
    const [wait] = await w.rows();
    expect(wait?.kind).toBe("secret");
    expect(wait?.requestId).toBeNull();

    // Not entered yet: left alone.
    await Promise.all(await w.sweep.tick());
    expect(w.resumed).toHaveLength(0);

    w.computer.enter(PASSWORD);
    await Promise.all(await w.sweep.tick());
    expect(w.resumed).toHaveLength(1);
    const content = w.resumed[0]?.content ?? "";
    expect(JSON.parse(content).ok).toBe(true);
    expect(content).not.toContain(PASSWORD);
    expect((await w.rows())[0]?.status).toBe("done");
  });

  test("entered in the moment between the wait ending and being recorded: the call answers itself, nothing is carried on twice", async () => {
    const w = await world("secret-race", { maxMs: 100, pollMs: 10 });
    // The value arrives while the wait is being written down: the store's `open` is where it lands.
    const open = w.store.open.bind(w.store);
    w.store.open = async (input) => {
      const wait = await open(input);
      w.computer.enter(PASSWORD);
      return wait;
    };
    const result = await w.call("computer_request_secret", args, "s4");
    expect(asJson(result)).toContain("the code");
    expect((await w.rows())[0]?.status).toBe("done");
    await Promise.all(await w.sweep.tick());
    expect(w.resumed).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------------------------
 * 3. Sign in
 * ---------------------------------------------------------------------------------------------- */

describe("computer_request_sign_in waits for the person", () => {
  const args = { site: "https://example.com", reason: "the report" };
  const ownerActor = (tenant: string) => ({
    id: tenant,
    userId: tenant,
    initiator: PERSON_INITIATOR,
  });

  const open = (w: Awaited<ReturnType<typeof world>>) =>
    [...w.signInStore.requests.values()].filter(
      (request) => request.ownerUserId === w.tenant,
    );

  test("signed in while it waits: the tool returns whether it worked, and the request had no turn on it", async () => {
    const w = await world("signin-in", { maxMs: 5_000, pollMs: 10 });
    later(80, () => {
      const [request] = open(w);
      if (request)
        void w.signInStore.transition(w.tenant, request.id, ["pending"], {
          status: "signed_in",
          method: "typed",
          resolvedAt: new Date(),
        });
    });
    const result = (await w.call(
      "computer_request_sign_in",
      args,
      "g1",
    )) as Record<string, unknown>;
    expect(result.signedIn).toBe(true);
    expect(asJson(result)).not.toContain(PASSWORD);
    // Answered while the tool waited: nothing was hung on the request to carry the turn on.
    expect(open(w)[0]?.continuation).toBeNull();
  });

  test("cancelled while it waits: the tool says the person chose not to sign in", async () => {
    const w = await world("signin-cancel", { maxMs: 5_000, pollMs: 10 });
    later(80, () => {
      const [request] = open(w);
      if (request)
        void w.service.cancel(w.tenant, request.id, ownerActor(w.tenant));
    });
    const result = (await w.call(
      "computer_request_sign_in",
      args,
      "g2",
    )) as Record<string, unknown>;
    expect(result.signedIn).toBe(false);
    expect(result.status).toBe("cancelled");
    // The hook that carries a turn on found no turn on it, so nothing ran twice.
    expect(w.answered.every((request) => request.continuation === null)).toBe(
      true,
    );
  });

  test("the wait runs out, the person answers later, and the answer carries the turn on", async () => {
    const w = await world("signin-late", { maxMs: 120, pollMs: 10 });
    const stopped = await suspension(
      w.call("computer_request_sign_in", args, "g3"),
    );
    expect(stopped.waiting.kind).toBe("computer_sign_in");
    const [request] = open(w);
    expect(stopped.waiting.signInRequestId).toBe(request?.id);
    // The turn is on the request now, and the request stays open for the person well past a quarter hour.
    expect(request?.continuation).not.toBeNull();
    expect((request?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      60 * 60_000,
    );

    // They answer (here, they decline): the service's own hook is handed the request with the turn on it.
    await w.service.cancel(w.tenant, request?.id ?? "", ownerActor(w.tenant));
    const carried = w.answered.filter((r) => r.id === request?.id);
    expect(carried).toHaveLength(1);
    expect(carried[0]?.continuation).not.toBeNull();
    expect(carried[0]?.status).toBe("cancelled");
  });

  test("answered between the wait ending and the turn being hung on the request: the call takes the answer itself", async () => {
    const w = await world("signin-race", { maxMs: 100, pollMs: 10 });
    // Wrap the service so the answer lands just before the turn is hung on the request.
    const real = w.service.attachContinuation;
    const tools = createHeadlessComputerTools({
      gateway: w.computer.gateway,
      seat: personSeat(w.tenant, BOT),
      actor: ownerActor(w.tenant),
      signIn: {
        request: (input) => w.service.request(input),
        record: (owner, id) => w.service.record(owner, id),
        attachContinuation: async (owner, id, continuation, keepOpenMs) => {
          await w.service.cancel(owner, id, ownerActor(w.tenant));
          return real(owner, id, continuation, keepOpenMs);
        },
      },
      waits: { store: w.store, maxMs: 100, pollMs: 10 },
    });
    const tool = tools.find(
      (candidate) => candidate.definition.name === "computer_request_sign_in",
    );
    if (!tool) throw new Error("no sign-in tool");
    const result = (await runAsTenant(w.tenant, () =>
      withApprovalContext(snapshotFor("thread-race", "g4", "x"), () =>
        tool.execute(args, {
          toolCallId: "g4",
          signal: new AbortController().signal,
        }),
      ),
    )) as Record<string, unknown>;
    expect(result.status).toBe("cancelled");
    // The hook ran with no turn on the request, so the only thing that answers the call is the call.
    expect(w.answered.every((request) => request.continuation === null)).toBe(
      true,
    );
  });

  test("Stop ends the wait at once", async () => {
    const w = await world("signin-stop", { maxMs: 60_000, pollMs: 10 });
    const stop = new AbortController();
    later(80, () => stop.abort());
    const started = Date.now();
    const result = (await w.call(
      "computer_request_sign_in",
      args,
      "g5",
      stop.signal,
    )) as Record<string, unknown>;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.stopped).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------------
 * The sweep and the resume
 * ---------------------------------------------------------------------------------------------- */

describe("the sweep", () => {
  test("two sweeps over one wait carry the turn on once", async () => {
    const w = await world("sweep-twice", { maxMs: 100, pollMs: 10 });
    await suspension(
      w.call("computer_request_help", { reason: "Sign in" }, "w1"),
    );
    w.computer.handBack("req-w1");
    const [first, second] = await Promise.all([w.sweep.tick(), w.sweep.tick()]);
    await Promise.all([...first, ...second]);
    expect(w.resumed).toHaveLength(1);
  });

  test("a turn that cannot be carried on is tried again, and given up on after the last try", async () => {
    const w = await world("sweep-retry", { maxMs: 100, pollMs: 10 });
    await suspension(
      w.call("computer_request_help", { reason: "Sign in" }, "w2"),
    );
    w.computer.handBack("req-w2");
    const failing = createComputerWaitSweep({
      store: w.store,
      gateway: w.computer.gateway as never,
      resume: async () => {
        throw new Error("the model is down");
      },
      log: () => undefined,
    });
    for (let attempt = 1; attempt <= MAX_RESUME_ATTEMPTS; attempt += 1) {
      await Promise.all(await failing.tick());
      const [row] = await w.rows();
      expect(row?.attempts).toBe(attempt);
      expect(row?.status).toBe(
        attempt === MAX_RESUME_ATTEMPTS ? "done" : "waiting",
      );
    }
    // Given up on: not tried a sixth time.
    await Promise.all(await failing.tick());
    expect((await w.rows())[0]?.attempts).toBe(MAX_RESUME_ATTEMPTS);
  });

  test("a computer that cannot be reached is not an answer and not a failed try", async () => {
    const w = await world("sweep-offline", { maxMs: 100, pollMs: 10 });
    await suspension(
      w.call("computer_request_help", { reason: "Sign in" }, "w3"),
    );
    const offline = createComputerWaitSweep({
      store: w.store,
      gateway: {
        seatFor: async () => personSeat(w.tenant, BOT),
        control: async () => {
          throw new Error("the computer is not reachable");
        },
        snapshot: async () => ({}),
      } as never,
      resume: async () => {
        throw new Error("must not be carried on");
      },
      log: () => undefined,
    });
    await Promise.all(await offline.tick());
    const [row] = await w.rows();
    expect(row?.status).toBe("waiting");
    expect(row?.attempts).toBe(0);
  });

  test("a wait is only found in the frame of its own tenant", async () => {
    const mine = await world("sweep-frame-a", { maxMs: 100, pollMs: 10 });
    const other = await world("sweep-frame-b", { maxMs: 100, pollMs: 10 });
    await suspension(
      mine.call("computer_request_help", { reason: "Sign in" }, "w4"),
    );
    const seen = await runAsTenant(other.tenant, () =>
      database
        .select({ id: computerWaits.id })
        .from(computerWaits)
        .where(
          and(
            eq(computerWaits.ownerUserId, mine.tenant),
            eq(computerWaits.botId, BOT),
          ),
        ),
    );
    expect(seen).toHaveLength(0);
  });
});

describe("the resume of a turn that waited", () => {
  const snapshot = snapshotFor("thread-resume", "r1", "computer_request_help");

  function resumer(
    overrides: Partial<Parameters<typeof createWaitResumer>[0]> = {},
  ) {
    const continued: { waitKey: string; messageId: string; content: string }[] =
      [];
    const replies: string[] = [];
    const resume = createWaitResumer({
      database,
      resumeResponsibility: async () => undefined,
      continueTurn: async (input) => {
        continued.push({
          waitKey: input.waitKey,
          messageId: input.messageId,
          content: input.result.content,
        });
        return { replyText: "carried on" };
      },
      recordReply: async ({ text }) => void replies.push(text),
      ...overrides,
    });
    return { resume, continued, replies };
  }

  const answer = (id: string) => ({
    key: "waitId" as const,
    id,
    ownerUserId: `nobody-${suite}`,
    botId: BOT,
    continuation: snapshot as unknown as Record<string, unknown>,
    content: '{"ok":true}',
    messageId: (s: ApprovalContinuation) =>
      `computer-wait-result:${id}:${s.toolCallId}`,
  });

  test("continues the turn from its snapshot with the outcome, under the id of the wait", async () => {
    const { resume, continued } = resumer();
    await runAsTenant(`nobody-${suite}`, () => resume(answer("wait-1")));
    expect(continued).toEqual([
      {
        waitKey: "wait-1",
        messageId: "computer-wait-result:wait-1:r1",
        content: '{"ok":true}',
      },
    ]);
  });

  test("a turn that stops again, on another wait, has ended where it should and is not tried again", async () => {
    const { resume } = resumer({
      continueTurn: async () => {
        throw new HeadlessToolSuspension("Waiting on the person again.", {
          kind: "computer_handoff",
        });
      },
    });
    await expect(
      runAsTenant(`nobody-${suite}`, () => resume(answer("wait-2"))),
    ).resolves.toBeUndefined();
  });

  test("a turn that fails is thrown on, for the sweep to count", async () => {
    const { resume } = resumer({
      continueTurn: async () => {
        throw new Error("the model is down");
      },
    });
    await expect(
      runAsTenant(`nobody-${suite}`, () => resume(answer("wait-3"))),
    ).rejects.toThrow("the model is down");
  });
});
