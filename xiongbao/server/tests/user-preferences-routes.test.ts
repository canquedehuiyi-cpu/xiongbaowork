import { expect, test } from "bun:test";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "@xiongbao/shared/user-preferences";
import { Hono } from "hono";
import { DEFAULT_TIME_ZONE } from "../src/tasks/delivery-tools";
import {
  DEFAULT_WORK_HOURS,
  type StoredUserPreferences,
  type UserPreferencesStore,
} from "../src/user-preferences";
import { userPreferencesRoutes } from "../src/user-preferences-routes";

/** 一个人的作息默认值：`DEFAULT_WORK_HOURS` 加上产品自己的时区，与 `readWorkHours` 的兜底一致。 */
const WORK_HOURS = { ...DEFAULT_WORK_HOURS, timeZone: DEFAULT_TIME_ZONE };

/** 一个人一开始的那一行：共享偏好 + 默认作息（真实 store 的 `read` 一定带 `workHours`）。 */
const DEFAULT_ROW: StoredUserPreferences = {
  ...DEFAULT_USER_PREFERENCES,
  workHours: WORK_HOURS,
};

function fixture() {
  const state = new Map<string, StoredUserPreferences>();
  const row = (id: string) => state.get(id) ?? DEFAULT_ROW;
  const store: UserPreferencesStore = {
    claimStarterTour: async () => {},
    read: async (id) => row(id),
    patch: async (id, patch) => {
      const { workHours, browserTimeZone, ...preferences } = patch;
      const current = row(id);
      /*
       * The merge the store does in Postgres, kept in the same order: the browser's zone goes under
       * what is saved, and this save's own hours over it. A row here always carries a zone, so the
       * browser's one never wins — which is the store's rule too ("fills a gap, never over one").
       */
      const saved: StoredUserPreferences = {
        ...current,
        ...preferences,
        workHours: {
          ...(browserTimeZone === undefined
            ? {}
            : { timeZone: browserTimeZone }),
          ...current.workHours,
          ...workHours,
        },
      };
      state.set(id, saved);
      return saved;
    },
  };
  function appFor(userId: string | null, available = true) {
    return new Hono().route(
      "/api/settings/preferences",
      userPreferencesRoutes(
        async (context, next) => {
          if (!userId) return context.json({ error: "Sign in" }, 401);
          context.set("actor", {
            id: userId,
            email: `${userId}@example.com`,
            role: "user",
          });
          await next();
        },
        available ? store : undefined,
      ),
    );
  }
  return { state, appFor };
}

const path = "/api/settings/preferences";
function patch(body: unknown) {
  return {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("preferences default to thread and persist separately for each authenticated user", async () => {
  const { appFor } = fixture();
  const alice = appFor("alice");
  expect(await (await alice.request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
      skin: "xiongbao",
      proactive: "on",
      workHours: WORK_HOURS,
    },
  });
  const saved = await alice.request(
    path,
    patch({ messageListEmphasis: "agent" }),
  );
  expect(saved.status).toBe(200);
  expect(await (await appFor("alice").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: false,
      skin: "xiongbao",
      proactive: "on",
      workHours: WORK_HOURS,
    },
  });
  expect(await (await appFor("bob").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
      skin: "xiongbao",
      proactive: "on",
      workHours: WORK_HOURS,
    },
  });
});

test.each([
  {},
  null,
  { selfHostBannerDismissed: "yes" },
  { messageListEmphasis: "invalid" },
  // The browser recording's narration choice, gone with it: a save of it is refused like any unknown key.
  { narration: "on" },
  { messageListEmphasis: "agent", userId: "bob" },
  { skin: "retired-skin" },
  { skin: "" },
  { skin: null },
  { proactive: "sometimes" },
  { proactive: true },
  { proactive: null },
  { starterTourDismissed: true },
  { starterTourDismissed: false },
  { starterTourDismissed: null },
  { starterTourChannelId: "replacement" },
])("rejects invalid or extra preference fields: %j", async (body) => {
  const { appFor, state } = fixture();
  expect((await appFor("alice").request(path, patch(body))).status).toBe(400);
  expect(state.size).toBe(0);
});

test("refuses malformed JSON, unauthenticated callers, and unavailable storage", async () => {
  const { appFor, state } = fixture();
  expect(
    (await appFor("alice").request(path, { method: "PATCH", body: "{" }))
      .status,
  ).toBe(400);
  for (const request of [undefined, patch({ messageListEmphasis: "agent" })]) {
    expect((await appFor(null).request(path, request)).status).toBe(401);
    expect((await appFor("alice", false).request(path, request)).status).toBe(
      503,
    );
  }
  expect(state.size).toBe(0);
});

test("saves the self-host banner dismissal without touching message list emphasis", async () => {
  const { appFor } = fixture();
  const alice = appFor("alice");
  await alice.request(path, patch({ messageListEmphasis: "agent" }));
  const saved = await alice.request(
    path,
    patch({ selfHostBannerDismissed: true }),
  );
  expect(saved.status).toBe(200);
  expect(await (await appFor("alice").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: true,
      skin: "xiongbao",
      proactive: "on",
      workHours: WORK_HOURS,
    },
  });
  expect(await (await appFor("bob").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
      skin: "xiongbao",
      proactive: "on",
      workHours: WORK_HOURS,
    },
  });
});

test("saves the skin on the account without touching the other preferences", async () => {
  const { appFor } = fixture();
  const alice = appFor("alice");
  await alice.request(path, patch({ messageListEmphasis: "agent" }));
  const saved = await alice.request(path, patch({ skin: "opendots" }));
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({
    preferences: {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: false,
      skin: "opendots",
      proactive: "on",
      workHours: WORK_HOURS,
    },
  });
  // Another browser signed in as Alice reads the same skin; Bob keeps the default.
  expect(await (await appFor("alice").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: false,
      skin: "opendots",
      proactive: "on",
      workHours: WORK_HOURS,
    },
  });
  expect(
    (
      (await (await appFor("bob").request(path)).json()) as {
        preferences: UserPreferences;
      }
    ).preferences.skin,
  ).toBe("xiongbao");
});

test("a skin XiongBao does not ship is refused with the skins it does", async () => {
  const { appFor } = fixture();
  const refused = await appFor("alice").request(
    path,
    patch({ skin: "retired-skin" }),
  );
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toContain(
    "xiongbao, classic, openduet, opendots, openmuse",
  );
});

test("check-ins start on, and a person's off is kept without touching the others", async () => {
  // Off stops every one of this person's Bots checking in; the default keeps them checking.
  const { appFor } = fixture();
  const alice = appFor("alice");
  expect((await (await alice.request(path)).json()).preferences.proactive).toBe(
    "on",
  );
  await alice.request(path, patch({ skin: "openduet" }));
  const saved = await alice.request(path, patch({ proactive: "off" }));
  expect(saved.status).toBe(200);
  expect(await (await appFor("alice").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
      skin: "openduet",
      proactive: "off",
      workHours: WORK_HOURS,
    },
  });
  expect(
    (await (await appFor("bob").request(path)).json()).preferences.proactive,
  ).toBe("on");
  await alice.request(path, patch({ proactive: "on" }));
  expect(
    (await (await appFor("alice").request(path)).json()).preferences.proactive,
  ).toBe("on");
});

test("a page that still sends the old default skin name is refused with the skins this build ships", async () => {
  // The window of that name has closed: it is no longer translated into the new one, it is simply an
  // unknown skin, and an unknown skin is refused without saving anything.
  const { appFor, state } = fixture();
  const refused = await appFor("alice").request(
    path,
    patch({ skin: "openbot" }),
  );
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toContain(
    "xiongbao, classic, openduet, opendots, openmuse",
  );
  expect(state.size).toBe(0);
});
