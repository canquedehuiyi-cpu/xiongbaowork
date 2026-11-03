import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  createGithubResponsibilityRoutes,
  type GithubResponsibilityBinding,
} from "../src/responsibilities/github";
import type { ResponsibilityEvent } from "../src/responsibilities/types";
import { isTenantFramed, requireTenant } from "../src/tenant/context";

const secret = "fixture-only-github-secret";
function request(
  body: string,
  signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
) {
  return new Request("https://openbot.test/binding-1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": signature,
    },
    body,
  });
}
function fixture(tenantId = "owner-1") {
  const events: ResponsibilityEvent[] = [];
  const frames: string[] = [];
  const routes = createGithubResponsibilityRoutes({
    async bindingFor(id): Promise<GithubResponsibilityBinding | null> {
      frames.push(`binding:${requireTenant()}`);
      return id === "binding-1"
        ? {
            tenantId,
            ownerUserId: "owner-1",
            repository: "openbot/demo",
            secret,
          }
        : null;
    },
    async ingest(event) {
      frames.push(`ingest:${isTenantFramed() ? requireTenant() : "none"}`);
      events.push(event);
      return { eventId: "event-1", duplicate: false, runIds: ["run-1"] };
    },
  });
  return { routes, events, frames };
}

test("signed GitHub event binds actor from owned repository registration", async () => {
  const { routes, events } = fixture();
  const response = await routes.fetch(
    request(
      JSON.stringify({
        action: "opened",
        ownerUserId: "attacker",
        repository: { full_name: "openbot/demo" },
        issue: { number: 6 },
      }),
    ),
  );
  expect(response.status).toBe(202);
  expect(events[0]?.ownerUserId).toBe("owner-1");
  expect(events[0]?.type).toBe("issues.opened");
  expect(events[0]?.externalId).toMatch(/^body-[0-9a-f]{64}$/);
});
test("wrong signature cannot enqueue GitHub work", async () => {
  const { routes, events } = fixture();
  expect(
    (
      await routes.fetch(
        request(
          JSON.stringify({ repository: { full_name: "openbot/demo" } }),
          "sha256=0000",
        ),
      )
    ).status,
  ).toBe(401);
  expect(events).toHaveLength(0);
});
test("valid signature for another repository cannot route to bound owner", async () => {
  const { routes, events } = fixture();
  expect(
    (
      await routes.fetch(
        request(JSON.stringify({ repository: { full_name: "other/repo" } })),
      )
    ).status,
  ).toBe(403);
  expect(events).toHaveLength(0);
});
test("the same signed event replayed with a fresh X-GitHub-Delivery dedupes", async () => {
  const { routes, events } = fixture();
  const body = JSON.stringify({
    action: "opened",
    repository: { full_name: "openbot/demo" },
  });
  for (const delivery of ["delivery-1", "delivery-2"]) {
    const replay = request(body);
    replay.headers.set("x-github-delivery", delivery);
    expect((await routes.fetch(replay)).status).toBe(202);
  }
  expect(events).toHaveLength(2);
  expect(events[0]?.externalId).toBe(events[1]?.externalId as string);
});
test("the binding is read as platform and the event ingested in the binding's own tenant (G01)", async () => {
  const { routes, events, frames } = fixture();
  const response = await routes.fetch(
    request(
      JSON.stringify({
        action: "opened",
        tenantId: "attacker",
        repository: { full_name: "openbot/demo" },
      }),
    ),
  );
  expect(response.status).toBe(202);
  expect(frames).toEqual(["binding:platform", "ingest:owner-1"]);
  expect(events).toHaveLength(1);
});
test("a binding stamped as nobody's, or with somebody other than its owner, is unknown and ingests nothing", async () => {
  for (const stamp of ["system", "platform", "", "owner-2"]) {
    const { routes, events } = fixture(stamp);
    const response = await routes.fetch(
      request(
        JSON.stringify({
          action: "opened",
          repository: { full_name: "openbot/demo" },
        }),
      ),
    );
    expect(response.status).toBe(404);
    expect(events).toHaveLength(0);
  }
});
