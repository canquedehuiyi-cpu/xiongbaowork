import { expect, test } from "bun:test";
import { createRunnerTransport } from "../src/computer/runner-transport";
import {
  createDeviceChannel,
  DeviceOfflineError,
} from "../src/devices/channel";

/**
 * Ticket 017's dispatch channel: a request written to a socket the machine opened, answered by the
 * same id, and never answered by anybody else.
 *
 * No HTTP and no database here on purpose. The property worth pinning is the one the device model
 * stands on — an action reaches exactly one machine, and silence from it is an error rather than a
 * result.
 */
function fakeSocket(captured: string[]) {
  return { send: (value: string) => captured.push(value) };
}

const tenant = { tenantId: "t-1", deviceId: "studio-1" };

test("Stop before dispatch sends nothing; Stop after dispatch retains an unknown outcome", async () => {
  const sent: string[] = [];
  const channel = createDeviceChannel();
  channel.attach(tenant, fakeSocket(sent));
  const stopped = new AbortController();
  stopped.abort();
  await expect(
    channel.dispatch(
      tenant,
      "files.write",
      {},
      1000,
      "before-stop",
      stopped.signal,
    ),
  ).rejects.toThrow("before dispatch");
  expect(sent).toHaveLength(0);
  const active = new AbortController();
  const result = channel
    .dispatch(tenant, "files.write", {}, 1000, "during-stop", active.signal)
    .catch((error) => error);
  active.abort();
  expect(await result).toMatchObject({ outcomeUnknown: true });
  await expect(
    channel.dispatch(tenant, "files.write", {}, 1000, "during-stop"),
  ).rejects.toThrow("outcome is unknown");
  expect(
    sent.filter((frame) => JSON.parse(frame).type === "action"),
  ).toHaveLength(1);
  expect(
    sent.some(
      (frame) =>
        JSON.parse(frame).type === "cancel" &&
        JSON.parse(frame).key === "during-stop",
    ),
  ).toBeTrue();
});

test("a dispatch writes one frame and settles on its answer", async () => {
  const sent: string[] = [];
  const channel = createDeviceChannel();
  const connection = channel.attach(tenant, fakeSocket(sent));

  const answer = channel.dispatch<{ exitCode: number }>(
    tenant,
    "exec",
    { command: "echo hi" },
    5_000,
  );
  const frame = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
  expect(frame.type).toBe("action");
  expect(frame.action).toBe("exec");
  expect(typeof frame.id).toBe("string");

  expect(
    channel.settle(tenant, {
      type: "result",
      id: frame.id,
      ok: true,
      output: { exitCode: 0, stdout: "hi\n" },
    }),
  ).toBeTrue();
  expect((await answer).exitCode).toBe(0);
  expect(connection).toBeTruthy();
});

test("a frame from another device cannot answer it", async () => {
  const sent: string[] = [];
  const channel = createDeviceChannel();
  channel.attach(tenant, fakeSocket(sent));

  const answer = channel.dispatch(tenant, "files.list", {});
  const id = (JSON.parse(sent[0] ?? "{}") as { id: string }).id;

  const other = { tenantId: "t-2", deviceId: "laptop-9" };
  expect(
    channel.settle(other, { type: "result", id, ok: true, output: "forged" }),
  ).toBeFalse();

  // Still outstanding: the same id from the right machine settles it.
  expect(
    channel.settle(tenant, {
      type: "result",
      id,
      ok: true,
      output: { entries: [] },
    }),
  ).toBeTrue();
  await expect(answer).resolves.toEqual({ entries: [] });
});

test("an error answer rejects, and a dead socket rejects everything in flight", async () => {
  const sent: string[] = [];
  const channel = createDeviceChannel();
  const connection = channel.attach(tenant, fakeSocket(sent));

  const refused = channel.dispatch(tenant, "exec", { command: "rm -rf /" });
  const id = (JSON.parse(sent[0] ?? "{}") as { id: string }).id;
  channel.settle(tenant, {
    type: "result",
    id,
    ok: false,
    error: "denied here",
  });
  await expect(refused).rejects.toThrow("denied here");

  const pending = channel.dispatch(tenant, "exec", { command: "sleep 60" });
  channel.detach(connection);
  await expect(pending).rejects.toThrow("went away");
});

test("nobody connected is said as an offline device, not as a failed action", async () => {
  const channel = createDeviceChannel();
  await expect(channel.dispatch(tenant, "exec", {})).rejects.toBeInstanceOf(
    DeviceOfflineError,
  );
  expect(channel.isReachable(tenant)).toBeFalse();
  expect(channel.reachableDevice("t-1")).toBeNull();
});

test("the transport speaks the gateway's paths to the right machine", async () => {
  const sent: string[] = [];
  const channel = createDeviceChannel();
  channel.attach(tenant, fakeSocket(sent));
  const transport = createRunnerTransport(channel);

  const answer = transport.post(
    "runner:t-1/studio-1",
    "bot-1",
    "/exec",
    { command: "ls" },
    undefined,
    2_000,
  );
  const frame = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
  expect(frame.action).toBe("exec");
  channel.settle(tenant, {
    type: "result",
    id: frame.id,
    ok: true,
    output: { exitCode: 0 },
  });
  await expect(answer).resolves.toEqual({ exitCode: 0 });

  const navigated = transport.navigate(
    "runner:t-1/studio-1",
    "bot-1",
    "https://hn.example.test",
  );
  const nav = JSON.parse(sent[1] ?? "{}") as Record<string, unknown>;
  expect(nav.action).toBe("navigate");
  expect((nav.payload as { url: string }).url).toBe("https://hn.example.test");
  channel.settle(tenant, {
    type: "result",
    id: nav.id,
    ok: true,
    output: { url: "x", title: "t", text: "", truncated: false, elapsedMs: 1 },
  });
  await expect(navigated).resolves.toMatchObject({ title: "t" });

  // A device is not a URL: an address that is not `runner:` is refused rather than guessed at.
  expect(() =>
    transport.post("http://computer.internal", "bot-1", "/exec", {}),
  ).toThrow("not a device");
});

/**
 * Whose browser a device drives is the server's fact, not the caller's.
 *
 * The runner keys a browser profile by the tenant and the employee a call names, and a profile is one
 * person's live sessions. So the two values that decide it must be the ones the gateway already had —
 * the tenant the device is paired to, and the Bot this action was governed and audited for — whatever
 * a model or a bug put in the JSON on the way through.
 */
test("a browser action carries the employee the gateway named, not the one the caller typed", async () => {
  const sent: string[] = [];
  const channel = createDeviceChannel();
  channel.attach(tenant, fakeSocket(sent));
  const transport = createRunnerTransport(channel);

  const clicked = transport.post(
    "runner:t-1/studio-1",
    "bot-1",
    "/click",
    {
      ref: "deadbeef:e7",
      snapshotId: 4,
      // A forged pair, in the shape a caller could write it.
      tenantId: "t-VICTIM",
      botId: "someone-elses-bot",
    },
  );
  const frame = JSON.parse(sent[0] ?? "{}") as {
    payload: Record<string, unknown>;
  };
  expect(frame.payload).toEqual({
    ref: "deadbeef:e7",
    snapshotId: 4,
    tenantId: "t-1",
    botId: "bot-1",
  });
  channel.settle(tenant, {
    type: "result",
    id: (JSON.parse(sent[0] ?? "{}") as { id: string }).id,
    ok: true,
    output: { action: "click", url: "https://example.test", elapsedMs: 5 },
  });
  await expect(clicked).resolves.toMatchObject({ action: "click" });

  // A read of the screen is the same call path, and needs the same stamp: `call` is how the gateway
  // asks for `/screenshot` and `/read`, and a page it cannot attribute is a page it must not open.
  const shot = transport.call<NavigateResult>(
    "runner:t-1/studio-1",
    "bot-2",
    "/screenshot",
  );
  const shotPayload = JSON.parse(sent[1] ?? "{}") as {
    payload: Record<string, unknown>;
  };
  expect(shotPayload.payload).toEqual({ tenantId: "t-1", botId: "bot-2" });
  channel.settle(tenant, {
    type: "result",
    id: (JSON.parse(sent[1] ?? "{}") as { id: string }).id,
    ok: true,
    output: { base64: "aGk=", width: 1, height: 1, capturedAt: "now" },
  });
  await expect(shot).resolves.toMatchObject({ width: 1 });

  // Navigation too, with its own deadline and its own idempotency key kept.
  const navigated = transport.navigate(
    "runner:t-1/studio-1",
    "bot-3",
    "https://example.test",
    "tool-call-9",
  );
  const nav = JSON.parse(sent[2] ?? "{}") as {
    key: string;
    payload: Record<string, unknown>;
  };
  expect(nav.key).toBe("tool-call-9");
  expect(nav.payload).toEqual({
    url: "https://example.test",
    tenantId: "t-1",
    botId: "bot-3",
  });
  channel.settle(tenant, {
    type: "result",
    id: (JSON.parse(sent[2] ?? "{}") as { id: string }).id,
    ok: true,
    output: { url: "x", title: "t", text: "", truncated: false, elapsedMs: 1 },
  });
  await expect(navigated).resolves.toMatchObject({ title: "t" });

  // A command keeps the body it was given, exactly. Bolting an identity onto a frame that does not
  // read it would make the wire and the audit trail disagree about what a `files.write` contained.
  const exec = transport.post(
    "runner:t-1/studio-1",
    "bot-1",
    "/exec",
    { command: "ipconfig" },
    undefined,
    2_000,
  );
  expect(JSON.parse(sent[3] ?? "{}")).toMatchObject({
    action: "exec",
    payload: { command: "ipconfig" },
  });
  expect(JSON.parse(sent[3] ?? "{}").payload.tenantId).toBeUndefined();
  channel.settle(tenant, {
    type: "result",
    id: (JSON.parse(sent[3] ?? "{}") as { id: string }).id,
    ok: true,
    output: { exitCode: 0 },
  });
  await expect(exec).resolves.toEqual({ exitCode: 0 });

  // And an action that cannot be attributed to anyone is refused on this side, rather than sent on to
  // become whatever the runner's fallback profile happens to be.
  await expect(
    transport.post("runner:t-1/studio-1", "   ", "/click", {
      ref: "deadbeef:e7",
      snapshotId: 4,
    }),
  ).rejects.toThrow("without one");
  expect(sent).toHaveLength(4);
});
