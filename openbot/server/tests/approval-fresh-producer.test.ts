import { expect, test } from "bun:test";
import { createApprovalService } from "../src/approvals/service";
import { approvalAction, type ApprovalRecord, type ApprovalStore, ApprovalNotFoundError } from "../src/approvals/types";
import { approvalFixtureModel, createApprovalFixtureService } from "./helpers/approval-producer-model";

function fixture() {
  const rows = new Map<string, ApprovalRecord>();
  const action = approvalAction({
    actorId: "owner", botId: "bot", toolRef: "click", effect: "write",
    scope: "fixture.invalid", args: {},
    continuation: { runId: "run", threadId: "thread", toolCallId: "call", toolName: "click",
      args: {}, messages: [], state: {}, context: [], forwardedProps: {} },
  });
  const requireRow = (owner: string, id: string) => {
    const row = rows.get(id);
    if (!row || row.ownerUserId !== owner) throw new ApprovalNotFoundError();
    return row;
  };
  const store: ApprovalStore = {
    enabled: async () => true, setEnabled: async () => {},
    open: async (value) => {
      const row: ApprovalRecord = { id: "approval", ownerUserId: value.actorId, action: structuredClone(value),
        status: "approved", decision: "allow_once", result: null,
        createdAt: new Date(0), decidedAt: new Date(0), consumedAt: null, completedAt: null };
      rows.set(row.id, row); return structuredClone(row);
    },
    get: async (owner, id) => structuredClone(requireRow(owner, id)),
    list: async () => [...rows.values()].map((row) => structuredClone(row)),
    decide: async (owner, id) => structuredClone(requireRow(owner, id)),
    consume: async (owner, id, digest) => {
      const row = requireRow(owner, id);
      if (row.action.actionDigest !== digest || row.status !== "approved" || row.result) return false;
      row.status = "consumed"; return true;
    },
    saveResult: async (owner, id, result) => {
      const row = requireRow(owner, id); if (row.result) return false;
      row.result = structuredClone(result); return true;
    },
    finish: async (owner, id) => { requireRow(owner, id).status = "completed"; },
    rules: async () => [], revoke: async () => {},
  };
  const service = createApprovalFixtureService(store);
  const model = approvalFixtureModel(store);
  const counts = { validate: 0, execute: 0, continue: 0 };
  const dependencies = {
    validate: async () => { counts.validate++; return action; },
    execute: async () => { counts.execute++; return "effect-result"; },
    continue: async () => { counts.continue++; },
  };
  const open = () => store.open(action);
  const run = () => service.resume("owner", "approval", dependencies);
  return { rows, action, store, service, model, counts, dependencies, open, run };
}

test("fresh default stays blocked before validation, execution or result writes", async () => {
  const h = fixture(); await h.open();
  const service = createApprovalService(h.store, undefined, undefined, { continuationRecovery: h.model.recovery });
  await expect(service.resume("owner", "approval", h.dependencies)).rejects.toThrow("approval_recovery_blocked");
  expect(h.counts).toEqual({ validate: 0, execute: 0, continue: 0 });
  expect(h.model.counts.commit).toBe(0);
});
test("fresh verifies its frozen owner binding before any side effect", async () => {
  const h = fixture(); await h.open(); h.model.invalidateSeed();
  await expect(h.run()).rejects.toThrow("approval_recovery_blocked");
  expect(h.counts).toEqual({ validate: 0, execute: 0, continue: 0 });
});
test("fresh missing original producer seed never reconstructs today's input", async () => {
  const h = fixture(); await h.open(); h.model.dropSeed("approval");
  await expect(h.run()).rejects.toThrow("approval_recovery_blocked");
  expect(h.counts.execute).toBe(0);
});
test("fresh publishes the committed result and then uses the receipt protocol", async () => {
  const h = fixture(); await h.open(); await h.run(); await h.run();
  expect(h.counts).toEqual({ validate: 1, execute: 1, continue: 1 });
  expect(h.model.counts).toMatchObject({ commit: 1, publish: 1, admit: 1 });
  expect((await h.store.get("owner", "approval")).status).toBe("completed");
});
test("result commit then publication failure recovers without executing again", async () => {
  const h = fixture(); await h.open(); h.model.failPublication();
  await expect(h.run()).rejects.toThrow("approval_recovery_unknown");
  expect(h.counts).toEqual({ validate: 1, execute: 1, continue: 0 });
  expect((await h.store.get("owner", "approval")).result).toEqual({ content: "effect-result" });
  await h.run();
  expect(h.counts).toEqual({ validate: 1, execute: 1, continue: 1 });
});
test("unknown result ACK uses the committed context on retry and never replays", async () => {
  const h = fixture(); await h.open(); h.model.loseResultAck();
  await expect(h.run()).rejects.toThrow("approval_recovery_unknown");
  await h.run();
  expect(h.counts).toEqual({ validate: 1, execute: 1, continue: 1 });
});
test("final refusal result ACK loss terminates without model continuation on retry", async () => {
  const h = fixture(); await h.open(); h.model.loseResultAck();
  const dependencies = { ...h.dependencies, refusal: async () => "Use Bots is off." };
  await expect(h.service.resume("owner", "approval", dependencies)).rejects.toThrow("approval_recovery_unknown");
  await h.service.resume("owner", "approval", dependencies);
  expect(h.counts).toEqual({ validate: 0, execute: 0, continue: 0 });
  expect(h.model.counts.finalFinish).toBe(1);
  expect((await h.store.get("owner", "approval")).status).toBe("completed");
});
test("consumed abandon reports unknown outcome, never claims the action did not run", async () => {
  const h = fixture(); await h.open(); await h.store.consume("owner", "approval", h.action.actionDigest);
  await h.service.abandon("owner", "approval", "out of tries", h.dependencies);
  expect(h.counts.execute).toBe(0); expect(h.counts.continue).toBe(1);
  expect((await h.store.get("owner", "approval")).result?.error).toContain("outcome is unknown");
});

test("settled abandon result prevents a stale validated resume from executing while continuation is pending", async () => {
  const h = fixture(); await h.open();
  const enteredValidate = Promise.withResolvers<void>();
  const releaseValidate = Promise.withResolvers<void>();
  const enteredContinue = Promise.withResolvers<void>();
  const releaseContinue = Promise.withResolvers<void>();
  const stale = h.service.resume("owner", "approval", {
    ...h.dependencies,
    validate: async () => {
      h.counts.validate++; enteredValidate.resolve();
      await releaseValidate.promise; return h.action;
    },
  });
  await enteredValidate.promise;
  const abandoning = h.service.abandon("owner", "approval", "platform unavailable", {
    continue: async () => {
      h.counts.continue++; enteredContinue.resolve();
      await releaseContinue.promise;
    },
  });
  await enteredContinue.promise;
  const settled = (await h.store.get("owner", "approval")).result;
  expect(settled?.error).toContain("could not be carried out");
  expect((await h.store.get("owner", "approval")).status).toBe("approved");
  releaseValidate.resolve();
  await stale;
  expect(h.counts.execute).toBe(0);
  expect((await h.store.get("owner", "approval")).result).toEqual(settled);
  expect(h.counts.continue).toBe(1);
  releaseContinue.resolve();
  await abandoning;
  expect((await h.store.get("owner", "approval")).status).toBe("completed");
});

test("stale approved abandon cannot publish a not-carried-out result after another worker consumed", async () => {
  const h = fixture(); await h.open();
  const enteredPreparation = Promise.withResolvers<void>();
  const releasePreparation = Promise.withResolvers<void>();
  const enteredExecution = Promise.withResolvers<void>();
  const releaseExecution = Promise.withResolvers<void>();
  const prepare = h.model.fresh.prepare;
  let holdFirst = true;
  h.model.fresh.prepare = async (context) => {
    if (holdFirst) {
      holdFirst = false; enteredPreparation.resolve();
      await releasePreparation.promise;
    }
    return prepare(context);
  };
  const abandoning = h.service.abandon("owner", "approval", "out of tries", h.dependencies);
  await enteredPreparation.promise;
  const running = h.service.resume("owner", "approval", {
    ...h.dependencies,
    execute: async () => {
      h.counts.execute++; enteredExecution.resolve();
      await releaseExecution.promise; return "actual-outcome";
    },
  });
  await enteredExecution.promise;
  releasePreparation.resolve(); await abandoning;
  expect((await h.store.get("owner", "approval")).result).toBeNull();
  expect(h.counts.continue).toBe(0);
  releaseExecution.resolve(); await running;
  expect((await h.store.get("owner", "approval")).result).toEqual({ content: "actual-outcome" });
  expect(h.counts.execute).toBe(1); expect(h.counts.continue).toBe(1);
});
test("unknown continuation effect is not admitted a second time after fresh result publication", async () => {
  const h = fixture(); await h.open();
  const dependencies = {
    ...h.dependencies,
    continue: async () => { h.counts.continue++; throw new Error("CPU target ACK unknown"); },
  };
  await expect(h.service.resume("owner", "approval", dependencies)).rejects.toThrow("approval_recovery_unknown");
  await expect(h.service.resume("owner", "approval", dependencies)).rejects.toThrow("approval_recovery_unknown");
  expect(h.counts.execute).toBe(1); expect(h.counts.continue).toBe(1);
  expect(h.model.counts.admit).toBe(1);
});
