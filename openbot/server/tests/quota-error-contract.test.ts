import { expect, test } from "bun:test";
import { QuotaExceeded, type QuotaMetric } from "../src/quota/limits";

// Serialization contract only: no quota service, database or provider is started.
const metrics: readonly { metric: QuotaMetric; words: string }[] = [
  { metric: "wakers", words: "coworkers" },
  { metric: "tasksPerMonth", words: "tasks per month" },
  { metric: "devices", words: "machines" },
  { metric: "customModels", words: "models of your own" },
];

for (const { metric, words } of metrics) {
  test(`serialized ${metric} refusal preserves its arithmetic and adds the plans route`, async () => {
    const refusal = new QuotaExceeded(metric, 2, 2, "Team");
    const response = new Response(JSON.stringify(refusal.body), {
      status: 402, headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      error: `The Team plan allows 2 ${words}; this workspace is using 2.`,
      code: "quota_exceeded", metric, used: 2, limit: 2, plan: "Team",
      upgradeUrl: "/plans",
    });
    expect(refusal.name).toBe("QuotaExceeded");
    expect(refusal.message).toBe(`The Team plan allows 2 ${words}; this workspace is using 2.`);
    expect(refusal.metric).toBe(metric);
    expect(refusal.used).toBe(2);
    expect(refusal.limit).toBe(2);
    expect(refusal.plan).toBe("Team");
  });
}

test("a zero custom-model allowance survives JSON without replacement values", () => {
  const refusal = new QuotaExceeded("customModels", 0, 0, "Free");
  expect(JSON.parse(JSON.stringify(refusal.body))).toEqual({
    error: "The Free plan allows 0 models of your own; this workspace is using 0.",
    code: "quota_exceeded", metric: "customModels", used: 0, limit: 0,
    plan: "Free", upgradeUrl: "/plans",
  });
});

test("navigation is fixed independently of the unchanged plan label", () => {
  const plan = "https://untrusted.invalid/upgrade?next=elsewhere";
  const refusal = new QuotaExceeded("devices", 7, 3, plan);
  const body = JSON.parse(JSON.stringify(refusal.body));
  expect(body.plan).toBe(plan);
  expect(body.error).toBe(`The ${plan} plan allows 3 machines; this workspace is using 7.`);
  expect(body.upgradeUrl).toBe("/plans");
  expect(Object.keys(body).sort()).toEqual([
    "code", "error", "limit", "metric", "plan", "upgradeUrl", "used",
  ]);
});
