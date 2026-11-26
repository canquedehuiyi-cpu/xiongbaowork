import { isIP } from "node:net";
import type { EgressRule } from "../computer/policy-network";

/*
 * THE DEPLOYMENT'S OWN SERVICES AS EGRESS RULES: what a computer's policy lets through for an address the deployment hands
 * it (the model proxy an external employee's agent reaches, `withDestinations` in computer/policy-network.ts). Each
 * service's origin only, host and port, never its neighbours on the same address.
 */

const DEFAULT_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
  "ws:": 80,
  "wss:": 443,
};

type Origin = { host: string; port: number };

function originOf(raw: string | undefined): Origin | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  return host && port ? { host, port } : null;
}

/**
 * Each is allowed on its own port only. An address is allowed as itself, since a domain rule never matches an address,
 * and `localhost` is this machine's loopback addresses, which is what it reaches.
 *
 * A name is allowed by name on its port (a domain rule also covers the names under it, on that port). Where the name
 * resolves to a public address the open web already allows it on every port; the port matters where it resolves inside
 * the deployment, which is the case this rule is for.
 */
function rulesFor({ host, port }: Origin): EgressRule[] {
  const addresses = host === "localhost" ? ["127.0.0.1", "::1"] : [host];
  if (addresses.some((address) => isIP(address) === 0))
    return [{ type: "domain", value: host, ports: String(port) }];
  return addresses.map((address) => ({
    type: "cidr",
    value: `${address}/${isIP(address) === 4 ? 32 : 128}`,
    ports: String(port),
  }));
}

function uniqueRules(rules: EgressRule[]): EgressRule[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = `${rule.type}:${rule.value}:${rule.ports ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The rules for these services' origins, host and port only (the model proxy a computer's agent reaches). */
export function originRules(
  urls: readonly (string | undefined)[],
): EgressRule[] {
  return uniqueRules(
    urls.flatMap((raw) => {
      const origin = originOf(raw);
      return origin ? rulesFor(origin) : [];
    }),
  );
}
