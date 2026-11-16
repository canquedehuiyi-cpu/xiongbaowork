import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

/*
 * Automatic Learning is optional (R0): it needs a connected CopilotKit Intelligence. Without one the
 * admin page asks its routes and is told so in words, instead of a 404 that reads like a broken
 * deployment.
 */
describe("the learning admin routes without Intelligence", () => {
  // One person, no sign-in and no Intelligence: the request reaches the route as that person, an
  // administrator, on a deployment that never set INTELLIGENCE_API_KEY.
  const app = createApp(
    loadConfig({
      DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
      KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      OPENBOT_SINGLE_USER: "true",
    }),
  );

  for (const path of ["settings", "overview", "status/some-bot"]) {
    test(`GET /api/admin/learning/${path} says Intelligence is not connected`, async () => {
      const response = await app.request(
        `http://localhost:3001/api/admin/learning/${path}`,
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as {
        error: string;
        intelligence: boolean;
      };
      expect(body.intelligence).toBe(false);
      expect(body.error).toContain("CopilotKit Intelligence");
      expect(body.error).toContain("INTELLIGENCE_API_KEY");
    });
  }

  test("a write is not answered as if it were saved", async () => {
    const response = await app.request(
      "http://localhost:3001/api/admin/learning/settings",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          defaultTarget: null,
          agents: {},
        }),
      },
    );
    expect(response.ok).toBe(false);
  });
});
