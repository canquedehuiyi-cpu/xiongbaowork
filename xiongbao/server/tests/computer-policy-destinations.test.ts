import { describe, expect, test } from "bun:test";
import { recorderOriginRules } from "../src/browser/egress";
import {
  type EgressPolicy,
  withDestinations,
} from "../src/computer/policy-network";

/*
 * 期八·二: the address an external employee's agent reaches the model proxy at is allowed in every
 * policy that lists destinations, so an administrator's allowlist does not cut it off from its model.
 */

const proxy = recorderOriginRules({
  openbotUrls: ["http://server.internal:3001/api/agent-model"],
  gatewayUrl: "",
});

describe("withDestinations", () => {
  test("the proxy's origin, host and port only, is what is added", () => {
    expect(proxy).toEqual([
      { type: "domain", value: "server.internal", ports: "3001" },
    ]);
  });

  test("an allowlist, with or without the defaults, gains it once", () => {
    for (const mode of ["allowlist_only", "defaults_plus_allowlist"] as const) {
      const policy: EgressPolicy = {
        mode,
        rules: [{ type: "domain", value: "example.com" }],
      };
      const widened = withDestinations(policy, proxy);
      expect(widened).toEqual({
        mode,
        rules: [...policy.rules, ...proxy],
      });
      // Already there: not added again.
      expect(withDestinations(widened, proxy)).toEqual(widened);
      // The policy it was given is not changed.
      expect(policy.rules).toHaveLength(1);
    }
  });

  test("allow_all needs nothing and deny_all stays what the organization said", () => {
    const all: EgressPolicy = { mode: "allow_all", rules: [] };
    const none: EgressPolicy = { mode: "deny_all", rules: [] };
    expect(withDestinations(all, proxy)).toBe(all);
    expect(withDestinations(none, proxy)).toBe(none);
  });

  test("no destinations is no change", () => {
    const policy: EgressPolicy = { mode: "allowlist_only", rules: [] };
    expect(withDestinations(policy, [])).toBe(policy);
  });

  test("an address given as an IP is a range rule, with its port", () => {
    expect(
      recorderOriginRules({
        openbotUrls: ["http://10.0.0.7:3001/api/agent-model"],
        gatewayUrl: "",
      }),
    ).toEqual([{ type: "cidr", value: "10.0.0.7/32", ports: "3001" }]);
  });
});
