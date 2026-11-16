import { describe, expect, test } from "bun:test";
import { createDeliveryRouter } from "../src/delivery/router";
import {
  type DeliveryBinding,
  type DeliveryInbox,
  type DeliveryOutbox,
  DeliveryProviderError,
} from "../src/delivery/types";
import { currentTenant, runAsTenant } from "../src/tenant/context";

type RouterStore = Parameters<typeof createDeliveryRouter>[0]["store"];
/**
 * The fixture store as the router takes it. Every method is here (the key set is checked), but the rows
 * are cut to what the router reads: the store's own row types carry every column of the table.
 */
const routerStore = (store: Record<keyof RouterStore, unknown>) =>
  store as unknown as RouterStore;

const scope = {
  ownerUserId: "owner",
  channelId: "channel",
  agentId: "bot",
  threadId: "canonical",
};
/*
 * Rows carry the tenant the database stamped on them; the owner here is a person, and tenants are
 * 1:1 with people, so the stamp is the owner's id (G01).
 */
const binding: DeliveryBinding & { tenantId: string } = {
  ...scope,
  tenantId: "owner",
  id: "binding",
  transport: "slack",
  realm: "T",
  identity: "U",
  address: "D",
  enabled: true,
};
function fixture(
  override: Partial<DeliveryBinding> = {},
  turnHook?: (router: ReturnType<typeof createDeliveryRouter>) => Promise<void>,
) {
  const ownedBinding = { ...binding, ...override };
  const inbox: DeliveryInbox & { tenantId: string } = {
    ...scope,
    tenantId: "owner",
    id: "in",
    bindingId: "binding",
    source: "slack",
    externalId: "event",
    text: "Hi",
    state: "queued",
    error: null,
  };
  const outbound: DeliveryOutbox & { tenantId: string } = {
    ...scope,
    tenantId: "owner",
    id: "out",
    bindingId: "binding",
    deviceId: null,
    transport: "slack",
    text: "Reply",
    kind: "reply",
    requestId: null,
    state: "queued",
    error: null,
    providerId: null,
  };
  const offered: unknown[] = [];
  const statuses: unknown[] = [];
  const calls: unknown[] = [];
  let live = true;
  const store = {
    findBinding: async (
      _source: string,
      realm: string,
      identity: string,
      address?: string,
    ) =>
      realm === ownedBinding.realm &&
      identity === ownedBinding.identity &&
      (!address || address === ownedBinding.address)
        ? ownedBinding
        : null,
    binding: async () => ownedBinding,
    bindingsFor: async () => [ownedBinding],
    bindingsByUse: async () => [ownedBinding],
    checkInConversations: async () => [],
    devices: async () => [],
    offerInbox: async (input: unknown) => {
      offered.push(input);
      return { queued: true, id: "in" };
    },
    inbox: async () => inbox,
    setInbox: async (_id: string, state: string, error?: string | null) => {
      statuses.push({ state, error });
    },
    offerOutbox: async (input: unknown) => {
      offered.push(input);
      return outbound;
    },
    outbox: async () => outbound,
    // A test replaces it with one that finds nothing to start.
    startOutbox: async (): Promise<typeof outbound | null> => outbound,
    setOutbox: async (
      _id: string,
      state: string,
      error?: string | null,
      providerId?: string,
    ) => {
      statuses.push({ state, error, providerId });
    },
    offerReceipt: async () => {},
    removeDevice: async () => {},
    device: async () => null,
    recordInbox: async (input: Record<string, unknown>) => {
      offered.push({ recorded: input });
      return input.externalId === "seen" ? null : { ...inbox, id: "in2" };
    },
    setSmsOptOut: async (...input: unknown[]) => {
      calls.push({ optOut: input });
      return [
        {
          id: "binding",
          tenantId: "owner",
          ownerUserId: "owner",
          channelId: "channel",
        },
      ];
    },
    botIdentity: async (agentId: string) => ({ agentId, name: "Research Bot" }),
  };
  const queue = {
    claim: async ({ kind }: { kind: string }) => [
      {
        kind,
        key: kind === "delivery.inbound" ? "in" : "out",
        tenantId: "owner",
        payload: {},
        attempts: 1,
      },
    ],
    renew: async () => live,
    finish: async () => true,
    release: async () => true,
  };
  const router = createDeliveryRouter({
    store: routerStore(store),
    queue,
    owner: "worker",
    authoriseScope: async () => live,
    scopeFor: async () => null,
    runTurn: async (input) => {
      calls.push(input);
      await turnHook?.(router);
      return { replyText: "Reply" };
    },
    providers: {
      slack: {
        send: async (input) => {
          calls.push(input);
          return { id: "ts", status: "sent" };
        },
      },
    },
  });
  return {
    router,
    store,
    queue,
    inbox,
    outbound,
    offered,
    statuses,
    calls,
    revoke: () => {
      live = false;
    },
  };
}
test("verified identity resolves canonical scope and suppresses echoes", async () => {
  const f = fixture();
  expect(
    await f.router.receive({
      source: "sms",
      realm: "T",
      identity: "U",
      address: "D",
      externalId: "e",
      text: "Hi",
      echo: true,
    }),
  ).toEqual({ queued: false });
  expect(f.offered).toHaveLength(0);
  await f.router.receive({
    source: "sms",
    realm: "T",
    identity: "U",
    address: "D",
    externalId: "e",
    text: "Hi",
  });
  expect(f.offered[0]).toMatchObject({
    ...scope,
    source: "sms",
    bindingId: "binding",
  });
});
test("queue invokes selected Bot and original conversation, emits durable async reply", async () => {
  const f = fixture();
  await f.router.sweep("delivery.inbound");
  expect(f.calls[0]).toMatchObject({ ...scope, runId: "in", text: "Hi" });
  expect(f.offered[0]).toMatchObject({
    ...scope,
    bindingId: "binding",
    transport: "slack",
    text: "Reply",
    kind: "reply",
  });
  expect(f.statuses.at(-1)).toMatchObject({ state: "sent" });
});
test("a turn knows where its message was written, so its surface can be told", async () => {
  const queued = fixture();
  await queued.router.sweep("delivery.inbound");
  const native = fixture();
  native.inbox.source = "native";
  await native.router.sweep("delivery.inbound");
  const paired = fixture();
  await paired.router.converse({
    transport: "teams",
    realm: "T",
    identity: "U",
    externalId: "m1",
    text: "Hi",
    signal: new AbortController().signal,
  });
  expect(
    [queued, native, paired].map(
      (f) => (f.calls[0] as { source?: unknown }).source,
    ),
  ).toEqual(["slack", "native", "teams"]);
});
test("revoked source ownership and lost lease cannot execute turns or sends", async () => {
  const f = fixture();
  f.revoke();
  await f.router.sweep("delivery.inbound");
  await f.router.sweep("delivery.outbound");
  expect(f.calls).toHaveLength(0);
});
test("uncertain recovered outbound is never silently resent", async () => {
  const f = fixture();
  f.outbound.state = "running";
  f.store.startOutbox = async () => null;
  await f.router.sweep("delivery.outbound");
  expect(f.calls).toHaveLength(0);
  expect(f.statuses).toContainEqual({
    state: "unknown",
    error:
      "Previous delivery stopped after sending began; inspect provider history before retrying.",
    providerId: undefined,
  });
});
test("provider refusal persists failure while uncertain network persists unknown", async () => {
  const f = fixture();
  const router = createDeliveryRouter({
    store: routerStore(f.store),
    queue: f.queue,
    owner: "w",
    authoriseScope: async () => true,
    scopeFor: async () => null,
    runTurn: async () => ({ replyText: "" }),
    providers: {
      slack: {
        send: async () => {
          throw new DeliveryProviderError("Slack", "network_error", true);
        },
      },
    },
  });
  await router.sweep("delivery.outbound");
  expect(f.statuses.at(-1)).toMatchObject({
    state: "unknown",
    error: "Slack delivery failed (network_error).",
  });
});

test("paired chat turn runs inline, is recorded once, and keeps its own approvals and questions", async () => {
  const f = fixture({}, async (router) => {
    await router.notify(scope, {
      id: "a1",
      text: "asks for approval",
      kind: "approval",
      requestId: "a1",
    });
    await router.notify(scope, {
      id: "q1",
      text: "Bot asks: which repo?",
      kind: "question",
      requestId: "q1",
    });
  });
  const result = await f.router.converse({
    transport: "slack",
    realm: "T",
    identity: "U",
    externalId: "m1",
    text: "Hi",
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({
    kind: "waiting",
    inboxId: "in2",
    replyText: "Reply",
    extras: {
      approvals: ["a1"],
      questions: [{ id: "q1", text: "Bot asks: which repo?" }],
    },
  });
  expect(f.calls[0]).toMatchObject({ ...scope, runId: "in2", text: "Hi" });
  // Neither the approval nor the question became a second, proactive Slack message.
  expect(f.offered.filter((o) => (o as { kind?: string }).kind)).toHaveLength(
    0,
  );
  expect(f.statuses.at(-1)).toMatchObject({ state: "sent" });
  // Once the turn ends, notifications go through the outbox again.
  await runAsTenant("owner", () =>
    f.router.notify(scope, { id: "r", text: "Later", kind: "question" }),
  );
  expect(f.offered.at(-1)).toMatchObject({
    kind: "question",
    transport: "slack",
  });
  expect(
    await f.router.converse({
      transport: "slack",
      realm: "T",
      identity: "U",
      externalId: "seen",
      text: "Hi",
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ kind: "duplicate" });
  expect(
    await f.router.converse({
      transport: "slack",
      realm: "T",
      identity: "STRANGER",
      externalId: "m2",
      text: "Hi",
      signal: new AbortController().signal,
    }),
  ).toEqual({ kind: "unbound" });
  expect(f.calls).toHaveLength(1);
});
test("a suspended governed turn reports its pending approval", async () => {
  const f = fixture();
  const suspended = Object.assign(new Error("waiting"), {
    name: "HeadlessToolSuspension",
    waiting: { kind: "approval", approvalId: "a9", requestId: "a9" },
  });
  const router = createDeliveryRouter({
    store: routerStore(f.store),
    queue: f.queue,
    owner: "w",
    authoriseScope: async () => true,
    scopeFor: async () => null,
    runTurn: async () => {
      throw suspended;
    },
    providers: {},
  });
  expect(
    await router.converse({
      transport: "slack",
      realm: "T",
      identity: "U",
      externalId: "m3",
      text: "go",
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ kind: "waiting", extras: { approvals: ["a9"] } });
  expect(f.statuses.at(-1)).toMatchObject({ state: "accepted" });
});
test("chat sends carry the Bot's identity; SMS after STOP is recorded opted out, not sent", async () => {
  const f = fixture();
  await f.router.sweep("delivery.outbound");
  expect(f.calls[0]).toMatchObject({
    address: "D",
    transport: "slack",
    sender: { agentId: "bot", name: "Research Bot" },
  });
  const sms = fixture({ transport: "sms", optedOutAt: new Date() });
  sms.outbound.transport = "sms";
  await sms.router.sweep("delivery.outbound");
  expect(sms.calls).toHaveLength(0);
  expect(sms.statuses.at(-1)).toMatchObject({ state: "opted_out" });
  expect(
    await sms.router.receive({
      source: "sms",
      realm: "T",
      identity: "U",
      externalId: "x",
      text: "hello",
    }),
  ).toEqual({ queued: false });
  const refused = fixture({ transport: "sms" });
  refused.outbound.transport = "sms";
  const router = createDeliveryRouter({
    store: routerStore(refused.store),
    queue: refused.queue,
    owner: "w",
    authoriseScope: async () => true,
    scopeFor: async () => null,
    runTurn: async () => ({ replyText: "" }),
    audit: async (event) => {
      refused.calls.push({ audit: event });
    },
    providers: {
      sms: {
        send: async () => {
          throw new DeliveryProviderError("Twilio", "21610");
        },
      },
    },
  });
  await router.sweep("delivery.outbound");
  expect(refused.calls).toContainEqual({ optOut: ["T", "U", true] });
  expect(refused.calls).toContainEqual({
    audit: {
      ownerUserId: "owner",
      channelId: "channel",
      id: "binding",
      kind: "sms_opt_out",
      state: "opted_out",
    },
  });
  expect(refused.statuses.at(-1)).toMatchObject({ state: "opted_out" });
});

test("the person's update routing decides which transports carry each kind", async () => {
  const f = fixture();
  const devices = [
    {
      id: "d1",
      ownerUserId: "owner",
      token: "t",
      projectId: "p",
      platform: "ios" as const,
      enabled: true,
    },
  ];
  f.store.devices = async () => devices;
  const kinds: string[] = [];
  const router = createDeliveryRouter({
    store: routerStore(f.store),
    queue: f.queue,
    owner: "w",
    authoriseScope: async () => true,
    scopeFor: async () => null,
    runTurn: async () => ({ replyText: "" }),
    providers: {},
    routeFor: async ({ kind }) => {
      kinds.push(kind);
      return {
        kind: kind === "reply" ? "progress" : "question",
        notify: true,
        allows: (transport) =>
          kind === "reply" ? transport === "push" : transport === "slack",
      };
    },
  });
  await runAsTenant("owner", async () => {
    await router.notify(scope, { id: "r1", text: "progress", kind: "reply" });
    await router.notify(scope, {
      id: "q1",
      text: "question",
      kind: "question",
    });
  });
  expect(kinds).toEqual(["reply", "question"]);
  expect(
    f.offered.map((row) => {
      const r = row as { kind: string; transport: string };
      return `${r.kind}:${r.transport}`;
    }),
  ).toEqual(["reply:push", "question:slack"]);
});

describe("whose delivery it is (G01)", () => {
  test("a queued delivery runs its turn and sends as the tenant stamped on its work item", async () => {
    const frames: string[] = [];
    const f = fixture({}, async () => {
      frames.push(`turn:${currentTenant()}`);
    });
    const startOutbox = f.store.startOutbox;
    f.store.startOutbox = async () => {
      frames.push(`send:${currentTenant()}`);
      return startOutbox();
    };
    const offerOutbox = f.store.offerOutbox;
    f.store.offerOutbox = async (input: unknown) => {
      frames.push(`reply:${currentTenant()}`);
      return offerOutbox(input);
    };
    // The sweep itself is the platform's; the work runs as the row's person.
    await runAsTenant("platform", () => f.router.sweep("delivery.inbound"));
    await runAsTenant("platform", () => f.router.sweep("delivery.outbound"));
    expect(frames).toEqual(["turn:owner", "reply:owner", "send:owner"]);
  });

  test("work stamped as nobody's is ended without a turn, a write or a send", async () => {
    for (const stamp of ["system", "platform", ""]) {
      const f = fixture();
      const finished: string[] = [];
      const claim = f.queue.claim;
      f.queue.claim = async (input: { kind: string }) =>
        (await claim(input)).map((item) => ({ ...item, tenantId: stamp }));
      f.queue.finish = async () => {
        finished.push(stamp);
        return true;
      };
      await f.router.sweep("delivery.inbound");
      await f.router.sweep("delivery.outbound");
      expect(f.calls).toHaveLength(0);
      expect(f.offered).toHaveLength(0);
      expect(f.statuses).toHaveLength(0);
      expect(finished).toEqual([stamp, stamp]);
    }
  });

  test("a row that is not the work item's tenant's own is left alone", async () => {
    // B's work item cannot run A's rows, and A's work item cannot run a `system` row in A's name.
    const foreign = fixture();
    const claim = foreign.queue.claim;
    foreign.queue.claim = async (input: { kind: string }) =>
      (await claim(input)).map((item) => ({ ...item, tenantId: "other" }));
    await foreign.router.sweep("delivery.inbound");
    await foreign.router.sweep("delivery.outbound");
    expect(foreign.calls).toHaveLength(0);
    expect(foreign.statuses).toHaveLength(0);

    const shared = fixture();
    shared.inbox.tenantId = "system";
    shared.outbound.tenantId = "system";
    await shared.router.sweep("delivery.inbound");
    await shared.router.sweep("delivery.outbound");
    expect(shared.calls).toHaveLength(0);
    expect(shared.statuses).toHaveLength(0);

    const misfiled = fixture();
    misfiled.inbox.ownerUserId = "other";
    misfiled.outbound.ownerUserId = "other";
    await misfiled.router.sweep("delivery.inbound");
    await misfiled.router.sweep("delivery.outbound");
    expect(misfiled.calls).toHaveLength(0);
  });

  test("a provider message is looked up as the platform and offered as the binding's tenant", async () => {
    const f = fixture();
    const frames: string[] = [];
    const findBinding = f.store.findBinding;
    f.store.findBinding = async (
      source: string,
      realm: string,
      identity: string,
      address?: string,
    ) => {
      frames.push(`find:${currentTenant()}`);
      return findBinding(source, realm, identity, address);
    };
    const offerInbox = f.store.offerInbox;
    f.store.offerInbox = async (input: unknown) => {
      frames.push(`offer:${currentTenant()}`);
      return offerInbox(input);
    };
    const message = {
      source: "sms" as const,
      realm: "T",
      identity: "U",
      externalId: "e",
      text: "Hi",
    };
    expect(await f.router.receive(message)).toMatchObject({ queued: true });
    expect(frames).toEqual(["find:platform", "offer:owner"]);

    // A binding stamped as nobody's, or as somebody other than its owner, queues nothing.
    for (const stamp of ["system", "platform", "other"]) {
      const g = fixture({ tenantId: stamp } as Partial<DeliveryBinding>);
      expect(await g.router.receive(message)).toEqual({ queued: false });
      expect(g.offered).toHaveLength(0);
    }
    // Nor does a webhook handled inside another person's frame.
    const h = fixture();
    expect(await runAsTenant("other", () => h.router.receive(message))).toEqual(
      { queued: false },
    );
    expect(h.offered).toHaveLength(0);
  });

  test("a paired chat turn runs as the binding's tenant, and never for a binding of nobody's", async () => {
    const frames: string[] = [];
    const f = fixture({}, async () => {
      frames.push(currentTenant());
    });
    const message = {
      transport: "slack" as const,
      realm: "T",
      identity: "U",
      externalId: "m1",
      text: "Hi",
      signal: new AbortController().signal,
    };
    expect(await f.router.converse(message)).toMatchObject({
      kind: "replied",
    });
    expect(frames).toEqual(["owner"]);
    for (const stamp of ["system", "platform", "other"]) {
      const g = fixture({ tenantId: stamp } as Partial<DeliveryBinding>);
      expect(await g.router.converse(message)).toEqual({ kind: "unbound" });
      expect(g.calls).toHaveLength(0);
      expect(g.offered).toHaveLength(0);
    }
  });

  test("a notification is queued only from inside its owner's own frame", async () => {
    const outside = [
      (notify: () => Promise<void>) => notify(),
      (notify: () => Promise<void>) => runAsTenant("system", notify),
      (notify: () => Promise<void>) => runAsTenant("platform", notify),
      (notify: () => Promise<void>) => runAsTenant("other", notify),
    ];
    for (const frame of outside) {
      const f = fixture();
      await frame(() =>
        f.router.notify(scope, { id: "r", text: "Reply", kind: "reply" }),
      );
      // Nothing is stamped `system` or filed under somebody else, to be dropped by the sweep later.
      expect(f.offered).toHaveLength(0);
    }
    const f = fixture();
    await runAsTenant("owner", () =>
      f.router.notify(scope, { id: "r", text: "Reply", kind: "reply" }),
    );
    expect(f.offered).toHaveLength(1);
  });

  test("a STOP marks the number as the platform and audits each binding as its own tenant", async () => {
    const f = fixture();
    const frames: string[] = [];
    f.store.setSmsOptOut = async () => {
      frames.push(`mark:${currentTenant()}`);
      return [
        {
          id: "mine",
          tenantId: "owner",
          ownerUserId: "owner",
          channelId: "channel",
        },
        {
          id: "nobodys",
          tenantId: "system",
          ownerUserId: "owner",
          channelId: "channel",
        },
      ];
    };
    const audited: Array<{ id: string; frame: string }> = [];
    const router = createDeliveryRouter({
      store: routerStore(f.store),
      queue: f.queue,
      owner: "w",
      authoriseScope: async () => true,
      scopeFor: async () => null,
      runTurn: async () => ({ replyText: "" }),
      audit: async (event) => {
        audited.push({ id: event.id, frame: currentTenant() });
      },
      providers: {},
    });
    expect(await router.smsOptOut("T", "U", true)).toBe(2);
    expect(frames).toEqual(["mark:platform"]);
    expect(audited).toEqual([{ id: "mine", frame: "owner" }]);
  });
});
