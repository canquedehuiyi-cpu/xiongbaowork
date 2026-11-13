import { afterEach, beforeEach, expect, test } from "bun:test";
import { readPolicy } from "../src/shared/policy";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

/**
 * The enterprise policy key (spec R7, check 2): IT writes XiongbaoUrl from now on; a browser still configured with the
 * older OpenBotUrl keeps its pinned address after the extension updates. The newer key wins whenever it is set.
 */

let fake: ChromeFake;
beforeEach(() => {
  fake = installChromeFake({ manifestVersion: "0.2.0" });
});
afterEach(() => {
  fake.uninstall();
});

test("XiongbaoUrl alone pins the Recorder to it", async () => {
  fake.storage.setManaged({ XiongbaoUrl: "https://work.example.test" });
  expect(await readPolicy()).toEqual({
    openbotUrl: "https://work.example.test",
    openbotUrlInvalid: false,
    allowedIntelligenceUrls: null,
  });
});

test("with both keys set, XiongbaoUrl wins", async () => {
  fake.storage.setManaged({
    XiongbaoUrl: "https://new.example.test",
    OpenBotUrl: "https://old.example.test",
  });
  expect((await readPolicy()).openbotUrl).toBe("https://new.example.test");
});

test("OpenBotUrl alone, as an older install wrote it, still pins the Recorder", async () => {
  fake.storage.setManaged({ OpenBotUrl: "https://old.example.test" });
  expect(await readPolicy()).toEqual({
    openbotUrl: "https://old.example.test",
    openbotUrlInvalid: false,
    allowedIntelligenceUrls: null,
  });
});

test("an invalid XiongbaoUrl refuses every connect even where a valid OpenBotUrl is also set", async () => {
  fake.storage.setManaged({
    XiongbaoUrl: "http://new.example.test",
    OpenBotUrl: "https://old.example.test",
  });
  expect(await readPolicy()).toMatchObject({
    openbotUrl: null,
    openbotUrlInvalid: true,
  });
});

test("the managed schema declares XiongbaoUrl as OpenBotUrl is declared", async () => {
  const schema = (await Bun.file(
    new URL("../public/managed_schema.json", import.meta.url),
  ).json()) as { properties: Record<string, unknown> };
  expect(schema.properties.XiongbaoUrl).toEqual(schema.properties.OpenBotUrl);
  expect(schema.properties.XiongbaoUrl).toMatchObject({ type: "string" });
});
