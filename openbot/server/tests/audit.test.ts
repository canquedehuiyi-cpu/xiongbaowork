import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/app";
import {
  auditEventTypes,
  createAuditReader,
  createAuditStore,
  recordAuditEvent,
  redactAuditPayload,
} from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const config = loadConfig({
  ...testEnvironment(),
});

const adminAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "admin", email: "admin@openbot.test" },
    }),
  },
};

const memberAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "member", email: "member@openbot.test" },
    }),
  },
};

describe("audit payload redaction", () => {
  test("defines the audit event taxonomy", () => {
    expect(auditEventTypes).toEqual(
      expect.arrayContaining([
        "configuration.changed",
        "credential.created",
        "credential.rotated",
        "credential.revoked",
        "mcp.call_succeeded",
        "mcp.call_rejected",
      ]),
    );
  });

  test("removes secret values and document content recursively", () => {
    expect(
      redactAuditPayload({
        connector: "google_drive",
        accessToken: "sensitive-token",
        nested: {
          content: "full document body",
          resultCategory: "succeeded",
        },
      }),
    ).toEqual({
      connector: "google_drive",
      accessToken: "[REDACTED]",
      nested: {
        content: "[REDACTED]",
        resultCategory: "succeeded",
      },
    });
  });

  test("writes only the redacted payload to the audit store", async () => {
    const writes: unknown[] = [];

    await recordAuditEvent(
      {
        insert: async (event) => {
          writes.push(event);
        },
      },
      {
        eventType: "credential.created",
        targetType: "credential",
        targetId: "credential-1",
        payload: { apiKey: "plaintext-key", provider: "openai" },
      },
    );

    expect(writes).toEqual([
      {
        eventType: "credential.created",
        targetType: "credential",
        targetId: "credential-1",
        payload: { apiKey: "[REDACTED]", provider: "openai" },
      },
    ]);
  });

  test("a direct store insert is redacted too", async () => {
    // Redaction used to live only in recordAuditEvent, so a direct insert()
    // stored secrets in cleartext. The store is the last line of defence.
    let stored: unknown;
    const store = createAuditStore({
      insert: () => ({
        values: (event: unknown) => {
          stored = event;
          return {
            returning: async () => [
              { id: "synthetic-audit-id", createdAt: new Date(0) },
            ],
          };
        },
      }),
    } as never);

    await store.insert({
      eventType: "credential.created",
      targetType: "credential",
      targetId: "credential-1",
      payload: { apiKey: "plaintext-key", provider: "openai" },
    } as never);

    expect(stored).toMatchObject({
      payload: { apiKey: "[REDACTED]", provider: "openai" },
    });
  });
});

describe("admin audit API", () => {
  test("returns a filtered audit page to an administrator", async () => {
    const queries: unknown[] = [];
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      {
        list: async (query) => {
          queries.push(query);
          return {
            events: [
              {
                id: "event-1",
                eventType: "connector.sync_succeeded",
                targetType: "connector",
                targetId: "drive-1",
                actorUserId: "admin",
                payload: { itemCount: 3 },
                createdAt: "2026-08-13T12:00:00.000Z",
              },
            ],
            nextCursor: "next-page",
          };
        },
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events?eventType=connector.sync_succeeded&limit=10",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [
        {
          id: "event-1",
          eventType: "connector.sync_succeeded",
          targetType: "connector",
          targetId: "drive-1",
          actorUserId: "admin",
          payload: { itemCount: 3 },
          createdAt: "2026-08-13T12:00:00.000Z",
        },
      ],
      nextCursor: "next-page",
    });
    expect(queries).toEqual([
      { eventType: "connector.sync_succeeded", limit: 10 },
    ]);
  });

  test("denies a non-admin caller", async () => {
    const app = createApp(
      config,
      memberAuth,
      { rolesForUser: async () => ["user"] },
      { list: async () => ({ events: [] }) },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events",
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only an admin can do this.",
    });
  });
});

/**
 * G01-E P7: the administrator's trail is the deployment's trail.
 *
 * Every audit row is stamped with the person it is about, and row-level security answers a person's
 * frame with that person's rows only. The admin route therefore reads as `platform`, through
 * `asAdminPlatform`, which needs the admin capability `adminCapability` grants after re-reading the
 * caller's role. Asked of the real reader over the real database, because a stub reader cannot tell
 * one frame from another.
 */
describe("the admin trail across people", () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const store = createAuditStore(database);
  const reader = createAuditReader(database);
  const suite = randomUUID().slice(0, 8);
  const adminId = `audit-admin-${suite}`;
  const first = `audit-person-a-${suite}`;
  const second = `audit-person-b-${suite}`;
  const target = `audit-target-${suite}`;

  const authFor = (id: string) => ({
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: { id, email: `${id}@openbot.test` },
      }),
    },
  });

  const seed = async () => {
    for (const person of [first, second, adminId]) {
      await runAsTenant(person, () =>
        recordAuditEvent(store, {
          eventType: "person.access_revoked",
          targetType: "person",
          targetId: target,
          actorUserId: person,
          payload: { suite },
        }),
      );
    }
  };
  const seeded = seed();

  test("an administrator's route returns every person's rows", async () => {
    await seeded;
    const app = createApp(
      config,
      authFor(adminId),
      { rolesForUser: async () => ["admin"] },
      reader,
    );

    const response = await app.request(
      `http://openbot.local/api/admin/audit-events?targetType=person&targetId=${target}&limit=10`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      events: { actorUserId: string }[];
    };
    expect(body.events.map((event) => event.actorUserId).sort()).toEqual(
      [adminId, first, second].sort(),
    );
  });

  test("the same reader in the administrator's own frame returns only the administrator's rows", async () => {
    await seeded;
    const page = await runAsTenant(adminId, () =>
      reader.list({ targetType: "person", targetId: target, limit: 10 }),
    );
    expect(page.events.map((event) => event.actorUserId)).toEqual([adminId]);
  });

  test("a person who is not an administrator gets 403 and no rows", async () => {
    await seeded;
    const app = createApp(
      config,
      authFor(first),
      { rolesForUser: async () => ["user"] },
      reader,
    );

    const response = await app.request(
      `http://openbot.local/api/admin/audit-events?targetType=person&targetId=${target}`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access required.",
    });
  });

  test("an administrator whose role was removed since sign-in gets no cross-person read", async () => {
    await seeded;
    // The session still says admin (the actor's role was decided at sign-in), but the role
    // repository no longer does, so `adminCapability` grants nothing and the read is refused.
    let reads = 0;
    const app = createApp(
      config,
      authFor(adminId),
      {
        rolesForUser: async () => (reads++ === 0 ? ["admin"] : ["user"]),
      },
      reader,
    );

    const response = await app.request(
      `http://openbot.local/api/admin/audit-events?targetType=person&targetId=${target}`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access required.",
    });
    expect(reads).toBe(2);
  });
});
