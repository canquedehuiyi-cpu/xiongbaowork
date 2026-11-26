// Where a computer's browser may reach the deployment's own services, by the rules `originRules` makes from their
// addresses (the model proxy an external employee's agent reaches): each service's origin, host and port only, judged by
// the computer's own filter rule (agent-computer/src/egress.ts, which the server imports rather than copies).
import { describe, expect, test } from "bun:test";
import { originRules } from "../src/browser/egress";
import {
  type EgressPolicy,
  egressDecision,
  parseEgressRules,
} from "../src/computer/policy-network";

/** An allowlist of these services' origins and nothing else. */
const policyFor = (urls: readonly (string | undefined)[]): EgressPolicy => ({
  mode: "allowlist_only",
  rules: originRules(urls),
});

const cloud = policyFor([
  "https://xiongbao.example.com",
  "https://app.example.com/",
  "wss://gateway.example.com/socket",
]);
const allowed = (host: string, resolved: string[] = []) =>
  egressDecision(cloud, host, 443, resolved).allowed;

describe("the deployment's own services, as origin rules", () => {
  test("reaches the named services by name wherever they resolve, and only those names", () => {
    expect(allowed("xiongbao.example.com", ["10.0.0.7"])).toBe(true);
    expect(allowed("app.example.com", ["10.0.0.8"])).toBe(true);
    expect(allowed("gateway.example.com", ["172.20.1.1"])).toBe(true);
    expect(allowed("evil.example.com", ["10.0.0.7"])).toBe(false);
    // A cloud's metadata endpoint stays out whatever a name says.
    expect(allowed("xiongbao.example.com", ["169.254.169.254"])).toBe(false);
  });

  test("a service by name is allowed on its own port, never the name's others", () => {
    // Resolving inside the deployment: a name on its own port only.
    const port = (host: string, to: number, resolved: string[]) =>
      egressDecision(cloud, host, to, resolved).allowed;
    expect(port("xiongbao.example.com", 443, ["10.0.0.7"])).toBe(true);
    expect(port("xiongbao.example.com", 8443, ["10.0.0.7"])).toBe(false);
    expect(port("gateway.example.com", 443, ["172.20.1.1"])).toBe(true);
    expect(port("gateway.example.com", 5432, ["172.20.1.1"])).toBe(false);
    const ported = policyFor([
      "http://xiongbao.internal:3001",
      "ws://gateway.internal:7103/socket",
    ]);
    expect(
      egressDecision(ported, "xiongbao.internal", 3001, ["10.0.0.7"]).allowed,
    ).toBe(true);
    expect(
      egressDecision(ported, "xiongbao.internal", 80, ["10.0.0.7"]).allowed,
    ).toBe(false);
    expect(
      egressDecision(ported, "gateway.internal", 7103, ["10.0.0.8"]).allowed,
    ).toBe(true);
    expect(
      egressDecision(ported, "gateway.internal", 3001, ["10.0.0.8"]).allowed,
    ).toBe(false);
  });

  test("an address given for a service is allowed as that address alone, on its own port", () => {
    const literal = policyFor(["http://10.0.0.9:3001", "ws://[fd00::9]:7103"]);
    expect(egressDecision(literal, "10.0.0.9", 3001).allowed).toBe(true);
    expect(egressDecision(literal, "fd00::9", 7103).allowed).toBe(true);
    expect(egressDecision(literal, "10.0.0.10", 3001).allowed).toBe(false);
    expect(egressDecision(literal, "10.0.0.9", 5432).allowed).toBe(false);
    expect(egressDecision(literal, "fd00::9", 3001).allowed).toBe(false);
  });

  // Two services on one address, as an end-to-end run had them on 127.0.0.1: allowing the address on every port let a
  // browser reach a third service on 7555 and a probe on 7498.
  test("two services on one address are reached on those two ports, never the address's others", () => {
    const shared = policyFor([
      undefined,
      "http://127.0.0.1:7460",
      "ws://127.0.0.1:7053/socket",
    ]);
    const reach = (host: string, port: number, resolved: string[] = []) =>
      egressDecision(shared, host, port, resolved).allowed;
    expect(reach("127.0.0.1", 7460)).toBe(true);
    expect(reach("127.0.0.1", 7053)).toBe(true);
    for (const port of [7555, 7498, 7050, 80, 443, 5432])
      expect([port, reach("127.0.0.1", port)]).toEqual([port, false]);
    // Nor by a name that resolves there, nor by its neighbours.
    expect(reach("intelligence.test", 7555, ["127.0.0.1"])).toBe(false);
    expect(reach("127.0.0.2", 7460)).toBe(false);
    expect(reach("::1", 7460)).toBe(false);
    expect(parseEgressRules(shared.rules)).toEqual({
      ok: true,
      rules: shared.rules,
    });
  });

  test("an origin with no port is allowed on its scheme's own, and localhost on the loopback addresses", () => {
    const defaults = policyFor([
      "https://10.0.0.9",
      "http://localhost:3010",
      "wss://[fd00::9]/socket",
    ]);
    const reach = (host: string, port: number, resolved: string[] = []) =>
      egressDecision(defaults, host, port, resolved).allowed;
    expect(reach("10.0.0.9", 443)).toBe(true);
    expect(reach("10.0.0.9", 80)).toBe(false);
    expect(reach("fd00::9", 443)).toBe(true);
    expect(reach("fd00::9", 80)).toBe(false);
    // The browser dialling localhost resolves it, and each address it resolves to must be allowed on that port.
    expect(reach("127.0.0.1", 3010)).toBe(true);
    expect(reach("::1", 3010)).toBe(true);
    expect(reach("localhost", 3010, ["127.0.0.1", "::1"])).toBe(true);
    expect(reach("localhost", 7555, ["127.0.0.1", "::1"])).toBe(false);
    expect(reach("127.0.0.1", 7555)).toBe(false);
  });
});
