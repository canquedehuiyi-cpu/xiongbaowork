import { expect, test } from "bun:test";
import { hasBrowserMarker } from "../src/browser-request-marker";
import { createDictationRoutes } from "../src/dictation/routes";

const lookup = (headers: Record<string, string>) => (name: string) =>
  headers[name];

test.each(["voice", "dictation"] as const)(
  "%s accepts the new and the legacy marker header, and refuses neither",
  (kind) => {
    expect(
      hasBrowserMarker(lookup({ [`x-xiongbao-${kind}`]: "1" }), kind),
    ).toBe(true);
    expect(hasBrowserMarker(lookup({ [`x-openbot-${kind}`]: "1" }), kind)).toBe(
      true,
    );
    expect(hasBrowserMarker(lookup({}), kind)).toBe(false);
    expect(
      hasBrowserMarker(lookup({ [`x-xiongbao-${kind}`]: "0" }), kind),
    ).toBe(false);
    // The two kinds do not stand in for each other.
    const other = kind === "voice" ? "dictation" : "voice";
    expect(
      hasBrowserMarker(lookup({ [`x-xiongbao-${other}`]: "1" }), kind),
    ).toBe(false);
  },
);

test("the dictation route reaches its body check with either header and 403s without one", async () => {
  const app = createDictationRoutes(
    async (context, next) => {
      context.set("actor", { id: "u", email: "u@example.com", role: "user" });
      await next();
    },
    { transcribe: async () => "text" },
  );
  const post = (headers: Record<string, string>) =>
    app.request("/transcriptions", { method: "POST", headers, body: "broken" });
  // 400 means the marker passed and the malformed body was what failed.
  expect((await post({ "x-xiongbao-dictation": "1" })).status).toBe(400);
  expect((await post({ "x-openbot-dictation": "1" })).status).toBe(400);
  expect((await post({})).status).toBe(403);
});
