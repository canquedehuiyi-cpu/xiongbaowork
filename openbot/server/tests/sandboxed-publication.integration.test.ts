import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createComponentRoutes } from "../src/components/routes";
import {
  createSandboxedStore,
  SandboxedNotFoundError,
  SandboxedPublicationRefusedError,
} from "../src/components/sandboxed";
import { createSandboxedRoutes } from "../src/components/sandboxed-routes";
import { createComponentStore } from "../src/components/store";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  components,
  sandboxedComponents,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * The Published switch on a playground component is the same switch as every other component's, but
 * publishing one is not the same act. The source lives beside the governance row, and a publication
 * that writes only the governance row offers every Bot a component that cannot draw.
 *
 * These tests cross the real route and both stores against Postgres. A mocked store could prove the
 * route called something; it could not prove the two rows commit together, the revision is stable on
 * a retry, or a failed governance write leaves the source unpublished.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const componentStore = createComponentStore(database);
const sandboxedStore = createSandboxedStore(database, auditStore);
const fixtureNames = new Set<string>();

/** Teardown reaches the deployment's catalogue rows, which no one person owns (G01). */
function asDeployment<T>(work: () => T): T {
  return runAsTenant("platform", work);
}

/*
 * Whether this connection is allowed to install a trigger on `components`.
 *
 * The rollback case below forces the publication to fail from INSIDE the database, which is the only
 * honest way to show the two rows commit together — and a trigger needs the TRIGGER privilege, which the
 * application role deliberately does not hold (it is not the table's owner, and `openbot_app` is meant to
 * be unable to change the schema it writes through). Asking the database is better than assuming: the
 * suite runs as the owner in some environments and as the app role in the ones that matter.
 *
 * Skipped rather than passed, and said out loud, because a case that silently stops running is how a
 * rollback guarantee comes to be untested while the file reads green.
 */
const canInstallTrigger = await asDeployment(() =>
  database.execute(
    sql`select has_table_privilege(current_user, 'components', 'trigger') as allowed`,
  ),
)
  .then((rows) => Boolean((Array.isArray(rows) ? rows[0] : rows)?.allowed))
  .catch(() => false);
if (!canInstallTrigger) {
  console.warn(
    "[skip] sandboxed-publication: this role cannot create a trigger on components, so the rollback case is SKIPPED, not passed. Run the suite with an owner connection to cover it.",
  );
}
const testWithTrigger = canInstallTrigger ? test : test.skip;

const ADMIN = {
  id: `user_${randomUUID().slice(0, 8)}`,
  email: "admin@openbot.test",
  role: "admin",
} as const;
/** A second administrator: the source rows are the team's, so they can edit what ADMIN saved. */
const ADMIN_B = {
  id: `user_${randomUUID().slice(0, 8)}`,
  email: "admin-b@openbot.test",
  role: "admin",
} as const;
/** A member: reads what is published, never a draft, and writes nothing. */
const MEMBER = {
  id: `user_${randomUUID().slice(0, 8)}`,
  email: "member@openbot.test",
  role: "user",
} as const;
const people = [ADMIN, ADMIN_B, MEMBER];

const scope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
let releaseRoleWriter: (() => Promise<void>) | undefined;

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asDeployment(() =>
    database
      .insert(users)
      .values(people.map(({ id, email }) => ({ id, email }))),
  );
  for (const { id } of [ADMIN, ADMIN_B])
    await asPlatform(() => setRole(database, id, "admin"));
});

afterAll(async () => {
  // `user_roles` follows its user by cascade.
  await asDeployment(() =>
    database.delete(users).where(
      inArray(
        users.id,
        people.map(({ id }) => id),
      ),
    ),
  );
  await releaseRoleWriter?.();
});

type Person = (typeof people)[number];

/*
 * Stands in for the session guard, which also runs the rest of the request inside the signed-in
 * person's tenant (G01). The routes then pass through `adminCapability`, which re-reads `user_roles`.
 */
const signedInAs =
  (person: Person): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { ...person });
    await runAsTenant(person.id, () => next());
  };
const asAdmin = signedInAs(ADMIN);

/*
 * `work` inside an admin request, the way the administrator's own page runs it: framed as the admin
 * and through `adminCapability`. The direct store calls and reads below run like this. Errors come
 * back out to the caller.
 */
async function asAdminRequest<T>(
  person: Person,
  work: () => Promise<T>,
): Promise<T> {
  let outcome: { value: T } | { error: unknown } | undefined;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", signedInAs(person), scope.adminCapability);
  app.get("/", async (context) => {
    outcome = await work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    return context.body(null, 204);
  });
  await app.request("http://openbot.test/");
  if (!outcome) throw new Error("The admin request never ran its work.");
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

function asAdministrator<T>(work: () => Promise<T>): Promise<T> {
  return asAdminRequest(ADMIN, work);
}

const routes = new Hono().route(
  "/components",
  createComponentRoutes(
    componentStore,
    asAdmin,
    auditStore,
    async () => true,
    sandboxedStore,
    scope.adminCapability,
  ),
);

/** The playground's own routes, signed in as `person`. */
const sandboxedRoutesAs = (person: Person) =>
  new Hono().route(
    "/sandboxed",
    createSandboxedRoutes(
      sandboxedStore,
      signedInAs(person),
      scope.adminCapability,
    ),
  );

function fixture(label: string) {
  const slug = `${label}_${randomUUID().slice(0, 8)}`;
  const name = `custom_${slug}`;
  fixtureNames.add(name);
  return { slug, name };
}

function postPublication(name: string, published: boolean) {
  return routes.request(
    `http://t/components/${encodeURIComponent(name)}/publication`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ published }),
    },
  );
}

async function saveDraft(
  slug: string,
  html = "<p>draft</p>",
  description = "Draws the draft.",
) {
  return sandboxedStore.save({
    slug,
    title: "A test card",
    description,
    html,
    css: "p { color: red }",
    jsFunctions: "",
    argumentSchema: { type: "object" },
    sampleArguments: {},
    by: ADMIN.email,
  });
}

async function governanceOf(name: string) {
  const [row] = await database
    .select()
    .from(components)
    .where(eq(components.name, name));
  return row;
}

async function sourceOf(name: string) {
  const [row] = await database
    .select()
    .from(sandboxedComponents)
    .where(eq(sandboxedComponents.name, name));
  return row;
}

afterEach(() =>
  asDeployment(async () => {
    for (const name of fixtureNames) {
      await database
        .delete(sandboxedComponents)
        .where(eq(sandboxedComponents.name, name));
      await database.delete(components).where(eq(components.name, name));
    }
    fixtureNames.clear();
  }),
);

describe("the generic Published switch on a sandboxed component", () => {
  test("publishes the source and the governance row together", () =>
    asAdministrator(async () => {
      const { slug, name } = fixture("publish");
      await saveDraft(slug);

      const response = await postPublication(name, true);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ published: true });
      const source = await sourceOf(name);
      const governance = await governanceOf(name);
      expect(source?.published).toBeTrue();
      expect(source?.publishedHtml).toBe("<p>draft</p>");
      expect(governance?.published).toBeTrue();
      expect(governance?.publishedDescription).toBe("Draws the draft.");
    }));

  test("refuses a sandboxed governance row with no source", () =>
    asAdministrator(async () => {
      const { name } = fixture("missing");
      await database.insert(components).values({
        name,
        title: "A missing source",
        kind: "sandboxed",
        draftDescription: "Draws something.",
        published: false,
        updatedBy: ADMIN.email,
      });

      const response = await postPublication(name, true);

      expect(response.status).toBe(409);
      expect((await governanceOf(name))?.published).toBeFalse();
    }));

  test("refuses a draft with empty HTML", () =>
    asAdministrator(async () => {
      const { slug, name } = fixture("empty");
      await saveDraft(slug, "   ");

      const response = await postPublication(name, true);

      expect(response.status).toBe(409);
      expect((await governanceOf(name))?.published).toBeFalse();
      const source = await sourceOf(name);
      expect(source?.published).toBeFalse();
      expect(source?.publishedHtml).toBeNull();
    }));

  test("refuses a draft with no description", () =>
    asAdministrator(async () => {
      const { slug, name } = fixture("descriptionless");
      await saveDraft(slug, "<p>draft</p>", "   ");

      const response = await postPublication(name, true);

      expect(response.status).toBe(409);
      expect((await governanceOf(name))?.published).toBeFalse();
      expect((await sourceOf(name))?.published).toBeFalse();
    }));

  test("a repeated publish keeps one revision and one audit event", () =>
    asAdministrator(async () => {
      const { slug, name } = fixture("repeat");
      await saveDraft(slug);

      expect((await postPublication(name, true)).status).toBe(200);
      expect((await postPublication(name, true)).status).toBe(200);

      expect((await sourceOf(name))?.revision).toBe(1);
      const events = await database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.targetId, name));
      expect(
        events.filter((event) => event.eventType === "component.published"),
      ).toHaveLength(1);
    }));

  testWithTrigger(
    "a failure after the source write rolls the whole publish back",
    () =>
      asAdministrator(async () => {
        const { slug, name } = fixture("rollback");
        await saveDraft(slug);
        const functionName = `reject_${name}`;
        const triggerName = `reject_${name}`;

        await database.execute(
          sql.raw(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.name = '${name}' THEN
            RAISE EXCEPTION 'forced publication failure';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER ${triggerName}
          BEFORE UPDATE ON components
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `),
        );

        try {
          await expect(
            sandboxedStore.publish(name, ADMIN.email),
          ).rejects.toThrow();

          const source = await sourceOf(name);
          const governance = await governanceOf(name);
          expect(source?.published).toBeFalse();
          expect(source?.publishedHtml).toBeNull();
          expect(source?.revision).toBe(0);
          expect(governance?.published).toBeFalse();
        } finally {
          await database.execute(
            sql.raw(`DROP TRIGGER ${triggerName} ON components`),
          );
          await database.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
        }
      }),
  );

  test("unpublish withdraws the source and the governance row together", () =>
    asAdministrator(async () => {
      const { slug, name } = fixture("unpublish");
      await saveDraft(slug);
      await sandboxedStore.publish(name, ADMIN.email);

      const response = await postPublication(name, false);

      expect(response.status).toBe(200);
      expect((await sourceOf(name))?.published).toBeFalse();
      expect((await governanceOf(name))?.published).toBeFalse();
      expect(
        (await sandboxedStore.published()).map((row) => row.name),
      ).not.toContain(name);
    }));
});

/**
 * Playground sources are the team's (G01-E P6b). One administrator's save is another
 * administrator's to edit, every member draws what is published, and a draft reaches no member: the
 * store and route projections carry no draft field (row-level security cannot hide columns of a
 * published row, so this is pinned at the projection, R7). Writes need the admin capability.
 */
describe("sandboxed components are the team's", () => {
  const draftKeys = (value: unknown): string[] =>
    JSON.stringify(value).match(/"draft[A-Za-z]*"/g) ?? [];

  test("an admin's publication is listed for a member, with no draft field in the store or the route", async () => {
    const { slug, name } = fixture("team_published");
    await asAdministrator(async () => {
      const saved = await saveDraft(slug);
      expect(saved.name).toBe(name);
      await sandboxedStore.publish(name, ADMIN.email);
      // An edit after publishing, so the draft and the published source differ.
      await saveDraft(slug, "<p>secret draft</p>", "A secret draft.");
    });

    // Stamped `team`, as `platform` sees it.
    const [stamped] = await asDeployment(() =>
      database
        .select({ tenantId: sandboxedComponents.tenantId })
        .from(sandboxedComponents)
        .where(eq(sandboxedComponents.name, name)),
    );
    expect(stamped?.tenantId).toBe(TEAM_TENANT);

    const published = await runAsTenant(MEMBER.id, () =>
      sandboxedStore.published(),
    );
    const mine = published.find((row) => row.name === name);
    expect(mine?.html).toBe("<p>draft</p>");
    expect(Object.keys(mine ?? {}).sort()).toEqual(
      ["argumentSchema", "css", "html", "jsFunctions", "name"].sort(),
    );
    expect(draftKeys(published)).toEqual([]);
    expect(JSON.stringify(published)).not.toContain("secret draft");

    const response = await sandboxedRoutesAs(MEMBER).request(
      "http://t/sandboxed/published",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      components: Array<{ name: string; html: string }>;
    };
    expect(body.components.find((row) => row.name === name)?.html).toBe(
      "<p>draft</p>",
    );
    expect(draftKeys(body)).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("secret draft");

    // The admin list is not the member's to read.
    expect(
      (await sandboxedRoutesAs(MEMBER).request("http://t/sandboxed")).status,
    ).toBe(403);
  });

  test("a member's frame never sees an unpublished draft", async () => {
    const { slug, name } = fixture("team_draft");
    await asAdministrator(() => saveDraft(slug));

    const rows = await runAsTenant(MEMBER.id, () =>
      database
        .select({ name: sandboxedComponents.name })
        .from(sandboxedComponents)
        .where(eq(sandboxedComponents.name, name)),
    );
    expect(rows).toEqual([]);
    // Neither does the `system` frame.
    const asSystem = await runAsTenant("system", () =>
      database
        .select({ name: sandboxedComponents.name })
        .from(sandboxedComponents)
        .where(eq(sandboxedComponents.name, name)),
    );
    expect(asSystem).toEqual([]);
  });

  test("a second admin lists, edits and publishes what the first one saved", async () => {
    const { slug, name } = fixture("team_second_admin");
    await asAdministrator(() => saveDraft(slug));

    const listed = await asAdminRequest(ADMIN_B, () => sandboxedStore.list());
    expect(listed.map((row) => row.name)).toContain(name);

    const edited = await asAdminRequest(ADMIN_B, () =>
      sandboxedStore.save({
        slug,
        title: "Edited by B",
        description: "Draws B's version.",
        html: "<p>b</p>",
        css: "",
        jsFunctions: "",
        argumentSchema: {},
        sampleArguments: {},
        by: ADMIN_B.email,
      }),
    );
    expect(edited.title).toBe("Edited by B");
    expect(edited.authoredBy).toBe(ADMIN_B.email);

    const response = await sandboxedRoutesAs(ADMIN_B).request(
      `http://t/sandboxed/${encodeURIComponent(name)}/publish`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const source = await asAdministrator(() => sourceOf(name));
    expect(source?.published).toBeTrue();
    expect(source?.publishedHtml).toBe("<p>b</p>");
    expect(source?.tenantId).toBe(TEAM_TENANT);
  });

  test("a member's direct update matches no row, and the store refuses the member", async () => {
    const { slug, name } = fixture("team_member_write");
    await asAdministrator(async () => {
      await saveDraft(slug);
      await sandboxedStore.publish(name, ADMIN.email);
    });

    await runAsTenant(MEMBER.id, async () => {
      // Readable, since it is published...
      expect(await sourceOf(name)).toBeDefined();
      // ...and not writable.
      const updated = await database
        .update(sandboxedComponents)
        .set({ publishedHtml: "<p>defaced</p>" })
        .where(eq(sandboxedComponents.name, name))
        .returning({ name: sandboxedComponents.name });
      expect(updated).toEqual([]);
      const deleted = await database
        .delete(sandboxedComponents)
        .where(eq(sandboxedComponents.name, name))
        .returning({ name: sandboxedComponents.name });
      expect(deleted).toEqual([]);
      await expect(
        sandboxedStore.unpublish(name, MEMBER.email),
      ).rejects.toThrow(SandboxedNotFoundError);
      await expect(sandboxedStore.remove(name, MEMBER.email)).rejects.toThrow(
        SandboxedNotFoundError,
      );
    });

    const source = await asAdministrator(() => sourceOf(name));
    expect(source?.publishedHtml).toBe("<p>draft</p>");
    expect(source?.published).toBeTrue();
    expect((await asAdministrator(() => governanceOf(name)))?.published).toBe(
      true,
    );
  });

  test("an admin without the capability matches no row and changes nothing", async () => {
    const { slug, name } = fixture("team_no_capability");
    await asAdministrator(async () => {
      await saveDraft(slug);
      await sandboxedStore.publish(name, ADMIN.email);
      await saveDraft(slug, "<p>next</p>");
    });

    // The admin's own frame, but not through `adminCapability`: a routine or a Bot turn of theirs.
    await runAsTenant(ADMIN.id, async () => {
      const updated = await database
        .update(sandboxedComponents)
        .set({ publishedHtml: "<p>defaced</p>" })
        .where(eq(sandboxedComponents.name, name))
        .returning({ name: sandboxedComponents.name });
      expect(updated).toEqual([]);
      // The published row IS readable here (team_read admits every person frame), but publish locks
      // it with SELECT ... FOR UPDATE, which must also pass the UPDATE policy's USING clause, and that
      // needs the admin capability. So the lock matches no row and the publish is refused.
      await expect(sandboxedStore.publish(name, ADMIN.email)).rejects.toThrow(
        SandboxedPublicationRefusedError,
      );
      await expect(sandboxedStore.remove(name, ADMIN.email)).rejects.toThrow(
        SandboxedNotFoundError,
      );
      // A save is an insert-or-update the database refuses outright.
      await expect(saveDraft(slug, "<p>uncapable</p>")).rejects.toThrow();
    });

    const source = await asAdministrator(() => sourceOf(name));
    expect(source?.publishedHtml).toBe("<p>draft</p>");
    expect(source?.draftHtml).toBe("<p>next</p>");
    expect(source?.revision).toBe(1);
    expect((await asAdministrator(() => governanceOf(name)))?.kind).toBe(
      "sandboxed",
    );
  });
});
