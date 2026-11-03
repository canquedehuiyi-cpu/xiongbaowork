import { expect, test } from "bun:test";
import { RequestError } from "../src/lib/client";
import {
  QUERY_RETRIES,
  queryClient,
  shouldRetryQuery,
} from "../src/query-client";

/*
 * This used to assert `retry` was the number 1. K4 requires that a 402 quota refusal is never
 * retried, which a bare number cannot express, so the default is now a function. This test is the
 * stricter replacement: still exactly one retry for an ordinary failure, and none for a 402.
 */
test("provides a shared query client for application server state", () => {
  const options = queryClient.getDefaultOptions().queries;
  expect(options?.retry).toBe(shouldRetryQuery);
  expect(options?.refetchOnWindowFocus).toBe(false);
  expect(QUERY_RETRIES).toBe(1);
});

test("an ordinary failure is retried exactly once", () => {
  for (const error of [new Error("boom"), new RequestError("down", 500)]) {
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(false);
  }
});

test("a 402 is never retried, with or without quota details", () => {
  const quota = new RequestError("full", 402, {
    code: "quota_exceeded",
    metric: "wakers",
    used: 2,
    limit: 2,
    plan: "Team",
    upgradeUrl: "/plans",
  });
  expect(quota.quota).toBeDefined();
  expect(shouldRetryQuery(0, quota)).toBe(false);
  expect(shouldRetryQuery(0, new RequestError("Payment required", 402))).toBe(
    false,
  );
});
