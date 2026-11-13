import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * CONTEXT.md: a named, ordered set of coworkers (`waker_groups`) is called 群组 — on every screen,
 * in every message the server sends back for a person to read, and in the code's own comments.
 * 小组 was the older word; two words for one thing is how two people end up describing different
 * features. This keeps it from coming back.
 */

const ROOTS = [
  new URL("../src", import.meta.url).pathname,
  new URL("../../server/src", import.meta.url).pathname,
];

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "generated") continue;
      yield* sourceFiles(path);
    } else if (/\.(ts|tsx)$/.test(name)) {
      yield path;
    }
  }
}

function linesMatching(match: (line: string) => boolean): string[] {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (match(line)) offenders.push(`${file}:${index + 1}`);
        });
    }
  }
  return offenders;
}

test("the app and the server say 群组, never 小组", () => {
  expect(linesMatching((line) => line.includes("小组"))).toEqual([]);
});

/*
 * CONTEXT.md: the coworker is 员工 on every screen. 唤醒者 and 数字员工 were synonyms for it, and
 * "Waker 管理" was the English-flavoured name of 员工管理. The brand 「熊宝数字员工」 is a product name,
 * not the term, so it stays; so does the role generator's instruction to the model, which is
 * written for the model rather than read by a person.
 */
const MODEL_PROMPT = "server/src/roles/generator.ts";

test("the app and the server say 员工, never 唤醒者, 数字员工 or Waker 管理", () => {
  expect(
    linesMatching(
      (line) =>
        line.includes("唤醒者") ||
        line.includes("Waker 管理") ||
        line.replaceAll("熊宝数字员工", "").includes("数字员工"),
    ).filter((where) => !where.includes(MODEL_PROMPT)),
  ).toEqual([]);
});

/*
 * CONTEXT.md: a 群组 with a chat is what used to be called a 群聊, so the word is retired
 * everywhere a person reads it. IM chats (the 触达 page and its components) are a different
 * thing and keep it; comments are skipped.
 */
const IM_CHATS = [
  "app/src/routes/_authed/_app/reachability.tsx",
  "app/src/components/reachability/",
];

test("the app and the server say 群组, never 群聊 (IM chats aside)", () => {
  // 跳过注释行：去掉首空白后以 //、/*、* 开头的行
  expect(
    linesMatching(
      (line) => line.includes("群聊") && !/^\s*(\/\/|\/\*|\*)/.test(line),
    ).filter((where) => !IM_CHATS.some((path) => where.includes(path))),
  ).toEqual([]);
});
