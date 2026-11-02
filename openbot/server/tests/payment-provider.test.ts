import { describe, expect, test } from "bun:test";
import {
  createManualPaymentProvider,
  MANUAL_PAYMENT_INSTRUCTIONS,
  type PlanChangeEvent,
  type PlanChangeHook,
  paymentProviderFromEnv,
  runPlanChangeHooks,
} from "../src/quota/payment-provider";

/**
 * Spec K3: the payment channel is reserved, not connected. These pin the seam's own rules — the
 * manual provider's answer, the boot-time refusal of a channel this build does not have, and hooks
 * that run in order and cannot be broken (or made to leak) by one that throws.
 */
const event: PlanChangeEvent = {
  tenantId: "tenant-a",
  fromPlanId: "free",
  toPlanId: "pro",
  actorId: "admin-1",
  provider: "manual",
  at: new Date("2026-11-02T00:00:00Z"),
};

describe("manual payment provider", () => {
  test("answers every checkout with the administrator instruction, and nothing to pay", async () => {
    const provider = createManualPaymentProvider();
    expect(provider.id).toBe("manual");
    expect(provider.kind).toBe("manual");
    expect(provider.instructions).toBe("由平台管理员切换套餐");
    expect(MANUAL_PAYMENT_INSTRUCTIONS).toBe("由平台管理员切换套餐");

    const result = await provider.checkout({
      tenantId: "tenant-a",
      fromPlanId: "free",
      toPlanId: "pro",
      actorId: "member-1",
    });
    expect(result).toEqual({
      kind: "manual",
      instructions: "由平台管理员切换套餐",
    });
    // No first plan either: the answer does not depend on where the tenant starts.
    expect(
      await provider.checkout({
        tenantId: "tenant-b",
        fromPlanId: null,
        toPlanId: "free",
        actorId: "member-2",
      }),
    ).toEqual(result);
  });
});

describe("paymentProviderFromEnv", () => {
  test("unset, blank and 'manual' all give the manual provider", () => {
    for (const env of [
      {},
      { OPENBOT_PAYMENT_PROVIDER: undefined },
      { OPENBOT_PAYMENT_PROVIDER: "" },
      { OPENBOT_PAYMENT_PROVIDER: "  " },
      { OPENBOT_PAYMENT_PROVIDER: "manual" },
      { OPENBOT_PAYMENT_PROVIDER: " Manual " },
    ]) {
      const provider = paymentProviderFromEnv(env);
      expect(provider.id).toBe("manual");
      expect(provider.kind).toBe("manual");
    }
  });

  test("any other value refuses to boot, without echoing what was set", () => {
    for (const value of [
      "stripe",
      "alipay",
      "wechat",
      "sk_live_not_a_provider",
    ]) {
      let thrown: unknown;
      try {
        paymentProviderFromEnv({ OPENBOT_PAYMENT_PROVIDER: value });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("OPENBOT_PAYMENT_PROVIDER");
      expect((thrown as Error).message).not.toContain(value);
    }
  });
});

describe("runPlanChangeHooks", () => {
  test("awaits each hook in order, every hook seeing the same event", async () => {
    const seen: string[] = [];
    const received: PlanChangeEvent[] = [];
    const slow: PlanChangeHook = async (change) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen.push("first");
      received.push(change);
    };
    const fast: PlanChangeHook = (change) => {
      seen.push("second");
      received.push(change);
    };
    await runPlanChangeHooks([slow, fast], event, () => {});
    // A hook that took longer still finished before the next one started.
    expect(seen).toEqual(["first", "second"]);
    expect(received).toEqual([event, event]);
  });

  test("a throwing hook is logged without its value, and the hooks after it still run", async () => {
    const logged: string[] = [];
    const seen: string[] = [];
    const secret = "sk-live-hook-secret-123";
    await runPlanChangeHooks(
      [
        () => {
          throw new TypeError(`upstream said ${secret}`);
        },
        async () => {
          await Promise.resolve();
          throw secret;
        },
        () => {
          seen.push("after");
        },
      ],
      event,
      (message) => logged.push(message),
    );
    expect(seen).toEqual(["after"]);
    expect(logged.length).toBe(2);
    expect(logged[0]).toContain("#0");
    expect(logged[0]).toContain("TypeError");
    expect(logged[1]).toContain("#1");
    for (const line of logged) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("upstream said");
    }
  });

  test("resolves (does not reject) when a hook fails, so a switch already written is never undone", async () => {
    await expect(
      runPlanChangeHooks(
        [
          () => {
            throw new Error("boom");
          },
        ],
        event,
        () => {},
      ),
    ).resolves.toBeUndefined();
  });

  test("no hooks is a no-op", async () => {
    const logged: string[] = [];
    await runPlanChangeHooks([], event, (message) => logged.push(message));
    expect(logged).toEqual([]);
  });
});
