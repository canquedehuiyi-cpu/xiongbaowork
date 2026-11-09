import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { textTranslations } from "../src/db/schema";
import { CATALOGUE } from "../src/plugins/catalogue";
import type { PluginStore } from "../src/plugins/store";
import { createTranslationRoutes } from "../src/translations/routes";
import {
  createTranslationStore,
  MAX_TRANSLATION_ATTEMPTS,
  translatePending,
} from "../src/translations/store";
import { needsChinese, sourceHash } from "../src/translations/text";
import {
  createTranslator,
  parseTranslations,
} from "../src/translations/translator";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Skills and plugins that arrive in English are shown in Chinese (migration 0145): reading their
 * texts queues the untranslated ones, a background pass asks the model, and the next read has them.
 * The originals are never replaced.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
/*
 * The cache is deployment-wide, but every statement still runs inside a frame: the background pass
 * runs as the platform and a read runs as the person asking. Wrapped here the same way.
 */
const framed = createTranslationStore(database);
const inPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);
const store: typeof framed = {
  chineseFor: (texts) => inPlatform(() => framed.chineseFor(texts)),
  pending: (limit) => inPlatform(() => framed.pending(limit)),
  record: (hash, translated) =>
    inPlatform(() => framed.record(hash, translated)),
  failed: (hash, error) => inPlatform(() => framed.failed(hash, error)),
};
const suite = randomUUID().slice(0, 8);
const written: string[] = [];
const text = (words: string) => {
  const value = `${words} (${suite})`;
  written.push(sourceHash(value));
  return value;
};

test("only English-looking text needs a Chinese version", () => {
  expect(needsChinese("Search files in Google Drive")).toBe(true);
  expect(needsChinese("搜索云端硬盘里的文件")).toBe(false);
  expect(needsChinese("Google Drive 文件搜索")).toBe(false);
  expect(needsChinese("  ")).toBe(false);
  expect(needsChinese("42")).toBe(false);
  expect(needsChinese("x".repeat(6001))).toBe(false);
});

test("the model's answer must be one translation per text, in order", () => {
  expect(parseTranslations('{"translations":["甲","乙"]}', 2)).toEqual([
    "甲",
    "乙",
  ]);
  expect(() => parseTranslations('{"translations":["甲"]}', 2)).toThrow();
  expect(() => parseTranslations("不是 JSON", 1)).toThrow();
  expect(() => parseTranslations('{"translations":[""]}', 1)).toThrow();
});

test("the prompt keeps names and commands and asks for one JSON object", async () => {
  let asked = "";
  const translate = createTranslator(async (prompt) => {
    asked = prompt;
    return '{"translations":["读取文件"]}';
  });
  expect(await translate(["Read a file"])).toEqual(["读取文件"]);
  expect(asked).toContain("简体中文");
  expect(asked).toContain('["Read a file"]');
  expect(asked).toContain("保留原样");
});

test("reading queues what is missing, a pass translates it, and the next read has it", async () => {
  const title = text("Send a weekly report");
  const already = `已经是中文的标题 ${suite}`;
  expect(await store.chineseFor([title, already])).toEqual({});

  const asked: string[][] = [];
  const report = await translatePending(store, async (texts) => {
    asked.push(texts);
    return texts.map((source) => `中文：${source}`);
  });
  expect(report.failed).toBe(0);
  expect(asked.flat()).toContain(title);
  expect(asked.flat()).not.toContain(already);

  expect(await store.chineseFor([title, already])).toEqual({
    [title]: `中文：${title}`,
  });
});

test("a text the model keeps failing on stops being asked for", async () => {
  const stubborn = text("A sentence the model cannot handle");
  await store.chineseFor([stubborn]);
  for (let pass = 0; pass < MAX_TRANSLATION_ATTEMPTS + 2; pass += 1) {
    await translatePending(store, async (texts) => {
      if (texts.includes(stubborn)) throw new Error("model said no");
      return texts.map((source) => `中文：${source}`);
    });
  }
  const waiting = await store.pending(1000);
  expect(waiting.some((row) => row.source === stubborn)).toBe(false);
  expect(await store.chineseFor([stubborn])).toEqual({});
});

test("the plugins read translates exactly the texts the caller can see", async () => {
  const toolDescription = text("Lists the files in a folder");
  const skillTitle = text("Weekly digest");
  const listSkillsActors: unknown[] = [];
  const plugins = {
    listServers: async () => [
      {
        title: text("Drive"),
        summary: "",
        tools: [{ name: "list_files", description: toolDescription }],
      },
    ],
    listSkills: async (actor: unknown) => {
      listSkillsActors.push(actor);
      return [{ title: skillTitle, summary: "", instructions: "" }];
    },
  } as unknown as Pick<PluginStore, "listServers" | "listSkills">;
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: `${suite}-reader`,
      email: "reader@example.test",
      role: "user",
    });
    await runAsTenant(`${suite}-reader`, () => next());
  };
  const routes = createTranslationRoutes(framed, plugins, requireUser);

  await routes.request("http://openbot.test/plugins");
  expect(listSkillsActors).toEqual([{ id: `${suite}-reader`, isAdmin: false }]);
  await translatePending(
    store,
    async (texts) => texts.map((source) => `中文：${source}`),
    { batch: 100 },
  );
  const response = await routes.request("http://openbot.test/plugins");
  const { zh } = (await response.json()) as { zh: Record<string, string> };
  expect(zh[toolDescription]).toBe(`中文：${toolDescription}`);
  expect(zh[skillTitle]).toBe(`中文：${skillTitle}`);
  // A text nobody here can read is never in the answer, translated or not.
  expect(Object.keys(zh).every((key) => !key.includes("cannot handle"))).toBe(
    true,
  );
});

test("an administrator can look up live texts no table holds; nobody else can, and only a few at a time", async () => {
  const live = text("Manage issues and pull requests");
  const as = (role: "admin" | "user") => {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: `${suite}-${role}`,
        email: `${role}@example.test`,
        role,
      });
      await runAsTenant(`${suite}-${role}`, () => next());
    };
    return createTranslationRoutes(
      framed,
      {
        listServers: async () => [],
        listSkills: async () => [],
      } as unknown as Pick<PluginStore, "listServers" | "listSkills">,
      requireUser,
    );
  };
  const lookup = (role: "admin" | "user", texts: unknown) =>
    as(role).request("http://openbot.test/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
    });

  expect((await lookup("user", [live])).status).toBe(403);
  expect(
    (
      await lookup(
        "admin",
        Array.from({ length: 61 }, (_, i) => `t${i}`),
      )
    ).status,
  ).toBe(400);

  const first = await lookup("admin", [live]);
  expect(first.status).toBe(200);
  expect(((await first.json()) as { zh: object }).zh).toEqual({});
  await translatePending(
    store,
    async (texts) => texts.map((source) => `中文：${source}`),
    { batch: 100 },
  );
  const second = await lookup("admin", [live]);
  expect(((await second.json()) as { zh: Record<string, string> }).zh).toEqual({
    [live]: `中文：${live}`,
  });
});

afterAll(async () => {
  // The catalogue's texts were queued by the plugins read too; leave the cache as it was found.
  for (const entry of CATALOGUE) {
    written.push(sourceHash(entry.title), sourceHash(entry.summary));
  }
  await inPlatform(async () => {
    await database
      .delete(textTranslations)
      .where(inArray(textTranslations.sourceHash, written));
  });
});
