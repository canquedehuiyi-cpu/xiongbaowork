import { expect, test } from "bun:test";
import { DEFAULT_RUN_END_NOTICE } from "@openbot/shared/user-preferences";
import { Hono } from "hono";
import type {
  RunEndNoticeStore,
  UserPreferencesStore,
} from "../src/user-preferences";
import { userPreferencesRoutes } from "../src/user-preferences-routes";

/**
 * The three run-end switches (期九·五) are read and saved on a path of their own, which the settings
 * page reads: `push`, `im` and `desktop`, all on until turned off, each saved on its own.
 */

const path = "/api/settings/preferences/run-notice";

function fixture(
  options: { withSwitches?: boolean; signedOut?: boolean } = {},
) {
  const state = new Map<string, typeof DEFAULT_RUN_END_NOTICE>();
  const row = (id: string) => state.get(id) ?? { ...DEFAULT_RUN_END_NOTICE };
  const runEndNotice: RunEndNoticeStore = {
    read: async (id) => row(id),
    patch: async (id, patch) => {
      const saved = { ...row(id), ...patch };
      state.set(id, saved);
      return saved;
    },
  };
  const store: UserPreferencesStore = {
    ...(options.withSwitches === false ? {} : { runEndNotice }),
    claimStarterTour: async () => {},
    read: async () => {
      throw new Error("the general read is not what this path is about");
    },
    patch: async () => {
      throw new Error("the general save is not what this path is about");
    },
  };
  const appFor = (userId: string | null) =>
    new Hono().route(
      "/api/settings/preferences",
      userPreferencesRoutes(async (context, next) => {
        if (!userId) return context.json({ error: "Sign in" }, 401);
        context.set("actor", {
          id: userId,
          email: `${userId}@example.com`,
          role: "user",
        });
        await next();
      }, store),
    );
  return { state, appFor };
}

const patch = (body: unknown) => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("all three are on until a person turns one off", async () => {
  const response = await fixture().appFor("alice").request(path);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    runNotice: { push: true, im: true, desktop: true },
  });
});

test("a save names any of them and keeps the rest", async () => {
  const f = fixture();
  const app = f.appFor("alice");
  const first = await app.request(path, patch({ push: false }));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({
    runNotice: { push: false, im: true, desktop: true },
  });
  const second = await app.request(path, patch({ desktop: false, im: false }));
  expect(await second.json()).toEqual({
    runNotice: { push: false, im: false, desktop: false },
  });
  expect(await (await app.request(path)).json()).toEqual({
    runNotice: { push: false, im: false, desktop: false },
  });
});

test("each person has their own", async () => {
  const f = fixture();
  await f.appFor("alice").request(path, patch({ push: false }));
  expect(await (await f.appFor("bob").request(path)).json()).toEqual({
    runNotice: { push: true, im: true, desktop: true },
  });
});

test("anything but booleans for those three keys is refused, and nothing is saved", async () => {
  const f = fixture();
  const app = f.appFor("alice");
  for (const body of [
    {},
    { push: "off" },
    { im: 0 },
    { sms: false },
    { push: false, extra: true },
    [],
    "push",
  ]) {
    const response = await app.request(path, patch(body));
    expect(response.status).toBe(400);
  }
  expect(f.state.size).toBe(0);
});

test("a person who is signed out can neither read nor save", async () => {
  const app = fixture().appFor(null);
  expect((await app.request(path)).status).toBe(401);
  expect((await app.request(path, patch({ push: false }))).status).toBe(401);
});

test("a deployment whose preferences are not available says so", async () => {
  const f = fixture({ withSwitches: false });
  const app = f.appFor("alice");
  expect((await app.request(path)).status).toBe(503);
  expect((await app.request(path, patch({ push: false }))).status).toBe(503);
});

test("the general save still refuses the switches: they have their own path", async () => {
  const response = await fixture()
    .appFor("alice")
    .request(
      "/api/settings/preferences",
      patch({ runEndNotice: { push: false } }),
    );
  expect(response.status).toBe(400);
});
