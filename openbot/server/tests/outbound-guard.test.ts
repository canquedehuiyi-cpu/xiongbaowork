import { describe, expect, test } from "bun:test";
import {
  addressRisk,
  assertResolvesPublic,
  checkOutboundUrl,
  guardedFetch,
  type OutboundLookup,
  OutboundRefusedError,
} from "../src/net/outbound-guard";

/**
 * The one door a tenant-chosen URL goes through before this server sends a credential to it.
 *
 * Audit defect #6: a model's base URL is typed by a tenant and then POSTed to with that tenant's
 * Bearer key, from inside the deployment. Every test here is a way that request used to reach
 * somewhere it must not — an internal address written literally, one written in a form the parser
 * rewrites, a public name that resolves inward, or a public answer that redirects inward.
 */

/** A resolver that answers from a table and records what it was asked. */
function fakeLookup(table: Record<string, string[]>): OutboundLookup & {
  asked: string[];
} {
  const asked: string[] = [];
  const lookup = (async (hostname: string) => {
    asked.push(hostname);
    const addresses = table[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  }) as OutboundLookup & { asked: string[] };
  lookup.asked = asked;
  return lookup;
}

/** A fetch that answers from a function and records every request it was handed. */
function fakeFetch(answer: (url: string) => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init });
    return answer(url);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("which addresses are inside the deployment", () => {
  const internal = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.5",
    "100.64.1.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.9.9.9",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
  ];
  for (const address of internal) {
    test(`${address} is internal`, () => {
      expect(addressRisk(address)).not.toBeNull();
    });
  }

  const metadata = [
    "169.254.169.254",
    "169.254.170.2",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "100.100.100.200",
  ];
  for (const address of metadata) {
    test(`${address} is the metadata service`, () => {
      expect(addressRisk(address)).toBe("metadata");
    });
  }

  test("any other link-local address is internal", () => {
    expect(addressRisk("169.254.1.1")).toBe("internal");
  });

  for (const address of [
    "8.8.8.8",
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.0.1",
    "172.32.0.1",
    "2606:4700::1111",
  ]) {
    test(`${address} is public`, () => {
      expect(addressRisk(address)).toBeNull();
    });
  }
});

describe("checking a URL before anything is stored or sent", () => {
  test("an ordinary https endpoint passes", () => {
    expect(checkOutboundUrl("https://api.example.com/v1")).toEqual({
      allowed: true,
      url: "https://api.example.com/v1",
    });
  });

  const refused = [
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/",
    "https://127.0.0.1/v1",
    "https://10.0.0.5/v1",
    "https://100.64.1.1/v1",
    "https://0.0.0.0/v1",
    "https://224.0.0.1/v1",
    "https://[::1]/v1",
    "https://[fe80::1]/v1",
    "https://[fc00::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[::ffff:a9fe:a9fe]/v1",
    // Spellings the URL parser rewrites into 127.0.0.1 before anybody compares anything.
    "https://2130706433/v1",
    "https://0x7f.1/v1",
    "https://0177.0.0.1/v1",
    "https://127.1/v1",
    "https://localhost/v1",
    "https://api.localhost/v1",
    "https://metadata.google.internal/",
    // The key would be sent in the clear, and anybody on the path could read it.
    "http://api.example.com/v1",
    // Credentials in the URL travel wherever the URL does.
    "https://user:pass@api.example.com/v1",
    "ftp://api.example.com/v1",
    "file:///etc/passwd",
    "not a url",
  ];
  for (const raw of refused) {
    test(`${raw} is refused`, () => {
      expect(checkOutboundUrl(raw).allowed).toBeFalse();
    });
  }

  test("a deployment that opted into private hosts may use one, over http", () => {
    expect(
      checkOutboundUrl("http://127.0.0.1:11434/v1", { allowPrivateHosts: true })
        .allowed,
    ).toBeTrue();
  });

  test("metadata is refused even with private hosts allowed or the host named", () => {
    for (const raw of [
      "http://169.254.169.254/",
      "http://[::ffff:169.254.169.254]/",
      "http://metadata.google.internal/",
    ]) {
      expect(
        checkOutboundUrl(raw, {
          allowPrivateHosts: true,
          allowedHosts: new Set([
            "169.254.169.254",
            "[::ffff:a9fe:a9fe]",
            "metadata.google.internal",
          ]),
        }).allowed,
      ).toBeFalse();
    }
  });

  test("a host the deployment named is admitted, and only that host", () => {
    const allowedHosts = new Set(["10.0.0.7:8000"]);
    expect(
      checkOutboundUrl("https://10.0.0.7:8000/v1", { allowedHosts }).allowed,
    ).toBeTrue();
    expect(
      checkOutboundUrl("https://10.0.0.8:8000/v1", { allowedHosts }).allowed,
    ).toBeFalse();
    expect(
      checkOutboundUrl("https://10.0.0.7:9000/v1", { allowedHosts }).allowed,
    ).toBeFalse();
  });

  test("naming a host opens its address, not plain http", () => {
    const allowedHosts = new Set(["10.0.0.7:8000"]);
    expect(
      checkOutboundUrl("http://10.0.0.7:8000/v1", { allowedHosts }).allowed,
    ).toBeFalse();
  });

  test("a bare named host covers its default port only, never any port", () => {
    const allowedHosts = new Set(["agents.internal"]);
    expect(
      checkOutboundUrl("https://agents.internal/v1", { allowedHosts }).allowed,
    ).toBeTrue();
    expect(
      checkOutboundUrl("https://agents.internal:6379/v1", { allowedHosts })
        .allowed,
    ).toBeFalse();
  });
});

describe("checking where a name actually resolves", () => {
  test("a public name that resolves inward is refused", async () => {
    const lookup = fakeLookup({ "rebind.example.com": ["127.0.0.1"] });
    await expect(
      assertResolvesPublic("https://rebind.example.com/v1", { lookup }),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
  });

  test("one internal answer among public ones is enough to refuse", async () => {
    const lookup = fakeLookup({
      "mixed.example.com": ["93.184.216.34", "10.0.0.5"],
    });
    await expect(
      assertResolvesPublic("https://mixed.example.com/v1", { lookup }),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
  });

  test("an IPv4-mapped IPv6 answer is judged as the IPv4 it carries", async () => {
    const lookup = fakeLookup({
      "mapped.example.com": ["::ffff:169.254.169.254"],
    });
    await expect(
      assertResolvesPublic("https://mapped.example.com/v1", {
        lookup,
        allowPrivateHosts: true,
      }),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
  });

  test("a name that resolves to metadata is refused even with private hosts allowed", async () => {
    const lookup = fakeLookup({ "meta.example.com": ["169.254.169.254"] });
    await expect(
      assertResolvesPublic("https://meta.example.com/", {
        lookup,
        allowPrivateHosts: true,
      }),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
  });

  test("a name that does not resolve is refused as unresolved, not as policy", async () => {
    const lookup = fakeLookup({});
    const error = await assertResolvesPublic("https://nowhere.example.com/", {
      lookup,
      viaProxy: () => false,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundRefusedError);
    expect((error as OutboundRefusedError).kind).toBe("unresolved");
  });

  test("behind an egress proxy, a name the pod cannot resolve is left to the proxy", async () => {
    const lookup = fakeLookup({});
    await assertResolvesPublic("https://api.example.com/v1", {
      lookup,
      viaProxy: () => true,
    });
    expect(lookup.asked).toEqual(["api.example.com"]);
  });

  test("behind an egress proxy, a name that resolves inward is still refused", async () => {
    const lookup = fakeLookup({ "inside.example.com": ["10.1.2.3"] });
    const error = await assertResolvesPublic("https://inside.example.com/v1", {
      lookup,
      viaProxy: () => true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundRefusedError);
    expect((error as OutboundRefusedError).kind).toBe("destination");
  });

  test("a public name resolving publicly passes", async () => {
    const lookup = fakeLookup({ "api.example.com": ["93.184.216.34"] });
    await assertResolvesPublic("https://api.example.com/v1", { lookup });
    expect(lookup.asked).toEqual(["api.example.com"]);
  });
});

describe("sending through the guard", () => {
  const lookup = fakeLookup({
    "api.example.com": ["93.184.216.34"],
    "inside.example.com": ["10.1.2.3"],
  });

  test("an internal destination is refused before anything is sent", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "https://inside.example.com/v1/chat/completions",
      "https://[::ffff:127.0.0.1]/v1",
    ]) {
      const network = fakeFetch(() => new Response("{}"));
      await expect(
        guardedFetch(
          url,
          { method: "POST", headers: { authorization: "Bearer sk-secret" } },
          { lookup, fetchImpl: network.impl },
        ),
      ).rejects.toBeInstanceOf(OutboundRefusedError);
      expect(network.calls).toHaveLength(0);
    }
  });

  test("a redirect is refused, not followed, and the key never reaches its target", async () => {
    const network = fakeFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    );
    await expect(
      guardedFetch(
        "https://api.example.com/v1/chat/completions",
        { method: "POST", headers: { authorization: "Bearer sk-secret" } },
        { lookup, fetchImpl: network.impl },
      ),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0]?.url).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(network.calls[0]?.init?.redirect).toBe("manual");
    expect(network.calls.some((call) => call.url.includes("169.254"))).toBe(
      false,
    );
  });

  test("an ordinary answer comes back as it is, with a deadline attached", async () => {
    const network = fakeFetch(() => new Response('{"ok":1}', { status: 200 }));
    const response = await guardedFetch(
      "https://api.example.com/v1/chat/completions",
      { method: "POST" },
      { lookup, fetchImpl: network.impl, timeoutMs: 5_000 },
    );
    expect(response.status).toBe(200);
    expect(network.calls[0]?.init?.redirect).toBe("manual");
    expect(network.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("a stalled name resolution is bounded by the deadline and by the caller's abort", async () => {
    const network = fakeFetch(() => new Response("{}"));
    const stalled = () => new Promise<never>(() => undefined);
    const timedOut = await guardedFetch(
      "https://stalled.example.com/v1",
      { method: "POST" },
      { lookup: stalled, fetchImpl: network.impl, timeoutMs: 50 },
    ).catch((error: unknown) => error);
    expect((timedOut as Error).name).toBe("TimeoutError");

    const caller = new AbortController();
    const cancelled = guardedFetch(
      "https://stalled.example.com/v1",
      { method: "POST", signal: caller.signal },
      { lookup: stalled, fetchImpl: network.impl },
    ).catch((error: unknown) => error);
    caller.abort(new Error("run stopped"));
    expect(((await cancelled) as Error).message).toBe("run stopped");
    expect(network.calls).toHaveLength(0);
  });

  test("the refusal does not repeat the credential", async () => {
    const network = fakeFetch(() => new Response("{}"));
    const refusal = await guardedFetch(
      "https://10.0.0.5/v1?key=sk-secret",
      { headers: { authorization: "Bearer sk-secret" } },
      { lookup, fetchImpl: network.impl },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OutboundRefusedError);
    expect(String((refusal as Error).message)).not.toContain("sk-secret");
  });
});
