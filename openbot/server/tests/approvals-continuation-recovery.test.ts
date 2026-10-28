import { recoveryFixture } from "./approval-recovery-port.test";
import { expect, test } from "bun:test";

// RED diagnostic regression: do not merge into the default suite before a
// persistent recovery design is implemented. Only the real service is under
// test; fixture callbacks below are NOT a model/runner or external side effect.
const service = new URL("../src/approvals/service.ts", import.meta.url)
  .pathname;
const types = new URL("../src/approvals/types.ts", import.meta.url).pathname;
const setup = `
import assert from "node:assert/strict";
import http from "node:http"; import https from "node:https";
import net from "node:net"; import tls from "node:tls"; import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
let networkAttempts = 0;
const deny = () => { networkAttempts++; throw new Error("C2-AR network forbidden"); };
http.request = deny; http.get = deny; https.request = deny; https.get = deny;
net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
tls.connect = deny; dns.lookup = deny; dns.resolve = deny;
dns.promises.lookup = deny; dns.promises.resolve = deny; syncBuiltinESMExports();
globalThis.fetch = deny; Bun.connect = deny; Bun.listen = deny; Bun.serve = deny;
const { createApprovalService } = await import(${JSON.stringify(service)});
const { approvalAction, ApprovalNotFoundError } = await import(${JSON.stringify(types)});
const action = approvalAction({actorId: "fixture-owner", botId: "fixture-bot",
  toolRef: "computer_click", effect: "write", scope: "fixture.invalid",
  args: {ref: "fixture-button"}, target: {ref: "fixture-button"},
  continuation: {runId: "fixture-run", threadId: "fixture-thread", toolCallId: "fixture-call",
    toolName: "computer_click", args: {ref: "fixture-button"}, messages: [],
    state: {}, context: [], forwardedProps: {}}});
const row = {id: "fixture-approval", ownerUserId: "fixture-owner", action,
  status: "consumed", decision: "allow_once", result: {content: "saved action result"},
  createdAt: new Date(0), decidedAt: new Date(0), consumedAt: new Date(0), completedAt: null};
const trace = []; let executes = 0; let continuations = 0; let observableEffects = 0;
let failFinishOnce = false; let failContinueOnce = false;
let barrierReads = 0; let releaseReads;
const barrier = new Promise(resolve => { releaseReads = resolve; });
let gateFirstTwoReads = false;
function owned(owner,id) {
  if (owner !== row.ownerUserId || id !== row.id) throw new ApprovalNotFoundError();
}
const unused = async () => { throw new Error("unused store method called"); };
const store = {
  enabled: async () => true, setEnabled: unused, open: unused, list: unused,
  decide: unused, rules: async () => [], revoke: unused,
  get: async (owner,id) => {
    owned(owner,id); const snapshot = structuredClone(row); trace.push("get:" + snapshot.status);
    if (gateFirstTwoReads && barrierReads < 2) {
      barrierReads++; if (barrierReads === 2) releaseReads(); await barrier;
    }
    return snapshot;
  },
  consume: async (owner,id,digest) => {
    owned(owner,id); trace.push("consume"); assert.equal(digest, action.actionDigest);
    if (row.status !== "approved") return false; row.status = "consumed"; return true;
  },
  saveResult: async (owner,id,result) => {
    owned(owner,id); trace.push("saveResult:" + (row.result ? "lost" : "won"));
    if (row.result) return false; row.result = structuredClone(result); return true;
  },
  finish: async (owner,id) => {
    owned(owner,id); trace.push("finish");
    if (failFinishOnce) { failFinishOnce = false; trace.push("finish:failure"); throw new Error("fixture finish failure"); }
    row.status = "completed"; row.completedAt = new Date(0);
  }
};
const service = createApprovalService(store);
const deps = {
  validate: async action => { trace.push("validate"); return action; },
  execute: async () => { executes++; trace.push("execute"); return "fixture action result"; },
  continue: async input => {
    continuations++; observableEffects++; trace.push("continue:effect");
    assert.equal(input.messageId, "approval:fixture-approval");
    if (failContinueOnce) { failContinueOnce = false; trace.push("continue:transport-unknown"); throw new TypeError("fixture unknown transport outcome"); }
  }
};
const resume = () => service.resume(row.ownerUserId, row.id, deps);
const emitTrace = label => {
  assert.equal(networkAttempts, 0);
  console.log(JSON.stringify({label, executes, continuations, observableEffects,
    status: row.status, result: row.result, networkAttempts, trace}));
};
`;

function isolated(body: string) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      "-e",
      setup + body,
    ],
    cwd: new URL("..", import.meta.url).pathname,
    env: { HOME: "/nonexistent-c2-ar-home", TZ: "UTC" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  console.info(
    `C2_AR_CHILD_EXIT=${result.exitCode}\n${new TextDecoder().decode(result.stdout)}`,
  );
  if (result.exitCode !== 0)
    console.info(new TextDecoder().decode(result.stderr));
  expect(result.exitCode).toBe(0);
}

test("RECOVERY: saved result terminal survives first approval completion failure", async () => {
  const h = recoveryFixture();
  h.failFinish();
  await expect(h.run()).rejects.toThrow("unknown");
  await h.run();
  h.trace();
  expect(h.counts).toMatchObject({
    execute: 0,
    oldContinue: 0,
    effects: 1,
    prepare: 1,
    finish: 1,
  });
});
test("RECOVERY: admitted effect then unknown never blindly replays", async () => {
  const h = recoveryFixture();
  h.unknownEffect();
  await expect(h.run()).rejects.toThrow("unknown");
  await expect(h.run()).rejects.toThrow("unknown");
  h.trace();
  expect(h.counts).toMatchObject({
    execute: 0,
    oldContinue: 0,
    effects: 1,
    admit: 1,
  });
});
test("RECOVERY: two workers saved result claim has one admission", async () => {
  const h = recoveryFixture();
  h.hold();
  const first = h.run();
  await h.entered.promise;
  await expect(h.run()).rejects.toThrow("busy");
  h.release();
  await first;
  h.trace();
  expect(h.counts).toMatchObject({
    execute: 0,
    oldContinue: 0,
    effects: 1,
    admit: 1,
  });
});

test("CONTROL: two consumed no-result workers without a port are blocked without effects", () =>
  isolated(`
row.result = null; gateFirstTwoReads = true;
const { ApprovalRecoveryBlockedError } = await import(${JSON.stringify(service)});
const before = structuredClone(row);
const storeCalls = []; const dependencyCalls = []; const optionReads = [];
const observe = (target, calls) => new Proxy(target, {
  get(object, key, receiver) {
    const value = Reflect.get(object, key, receiver);
    if (typeof value !== "function") return value;
    return (...args) => { calls.push(String(key)); return Reflect.apply(value, object, args); };
  }
});
// No recovery port is installed. The actual options boundary is observed;
// there is no invented ensure/provision API or success callback in this fixture.
const noPort = new Proxy({}, {
  get(object, key, receiver) {
    optionReads.push(String(key)); return Reflect.get(object, key, receiver);
  }
});
const guardedService = createApprovalService(observe(store, storeCalls), undefined, undefined, noPort);
optionReads.length = 0;
const guardedResume = () => guardedService.resume(row.ownerUserId, row.id, observe(deps, dependencyCalls));
const blocked = error => {
  assert.ok(error instanceof ApprovalRecoveryBlockedError);
  assert.equal(error.name, "ApprovalRecoveryBlockedError");
  assert.equal(error.message, "approval_recovery_blocked");
  return true;
};
await Promise.all([
  assert.rejects(guardedResume(), blocked),
  assert.rejects(guardedResume(), blocked),
]);
assert.equal(executes, 0); assert.equal(continuations, 0); assert.equal(observableEffects, 0);
assert.deepEqual(dependencyCalls, []);
// Exact calls prove no consume/saveResult/finish or other state-saving method;
// no recovery context/port is reached, hence no downstream ensure/provision.
assert.deepEqual(storeCalls, ["get", "get"]);
assert.equal(storeCalls.filter(method => method === "saveResult").length, 0);
assert.equal(storeCalls.filter(method => method !== "get").length, 0);
assert.deepEqual(optionReads, []);
assert.deepEqual(row, before);
emitTrace("consumed-no-result-blocked-control");
`));

test("CONTROL: approved no-result retries without a port remain blocked and unchanged", () =>
  isolated(`
row.status = "approved"; row.result = null;
const { ApprovalRecoveryBlockedError } = await import(${JSON.stringify(service)});
const before = structuredClone(row);
const storeCalls = []; const dependencyCalls = []; const optionReads = [];
const observe = (target, calls) => new Proxy(target, {
  get(object, key, receiver) {
    const value = Reflect.get(object, key, receiver);
    if (typeof value !== "function") return value;
    return (...args) => { calls.push(String(key)); return Reflect.apply(value, object, args); };
  }
});
// No recovery port is installed. The actual options boundary is observed;
// there is no invented ensure/provision API or success callback in this fixture.
const noPort = new Proxy({}, {
  get(object, key, receiver) {
    optionReads.push(String(key)); return Reflect.get(object, key, receiver);
  }
});
const guardedService = createApprovalService(observe(store, storeCalls), undefined, undefined, noPort);
optionReads.length = 0;
const guardedResume = () => guardedService.resume(row.ownerUserId, row.id, observe(deps, dependencyCalls));
const blocked = error => {
  assert.ok(error instanceof ApprovalRecoveryBlockedError);
  assert.equal(error.name, "ApprovalRecoveryBlockedError");
  assert.equal(error.message, "approval_recovery_blocked");
  return true;
};
await assert.rejects(guardedResume(), blocked);
await assert.rejects(guardedResume(), blocked);
assert.equal(executes, 0); assert.equal(continuations, 0); assert.equal(observableEffects, 0);
assert.deepEqual(dependencyCalls, []);
// Exact calls prove no consume/saveResult/finish or other state-saving method;
// no recovery context/port is reached, hence no downstream ensure/provision.
assert.deepEqual(storeCalls, ["get", "get"]);
assert.equal(storeCalls.filter(method => method === "saveResult").length, 0);
assert.equal(storeCalls.filter(method => method !== "get").length, 0);
assert.deepEqual(optionReads, []);
assert.deepEqual(row, before);
emitTrace("approved-no-result-blocked-control");
`));
