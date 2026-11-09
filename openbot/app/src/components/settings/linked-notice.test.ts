import { describe, expect, test } from "bun:test";
import { linkedNotice, visibleLinkedNotice } from "./linked-notice";

describe("linkedNotice", () => {
  test("reports a linked GitHub account", () => {
    expect(linkedNotice("github")).toEqual({
      tone: "success",
      text: "你的 GitHub 账号已关联。",
    });
  });

  test("reports a failed link", () => {
    expect(linkedNotice("failed")).toEqual({
      tone: "error",
      text: "GitHub 账号没能关联，请再试一次。",
    });
  });

  test("tells the person the GitHub account belongs to another user, as an alert", () => {
    expect(linkedNotice("github-taken")).toEqual({
      tone: "error",
      text: "这个 GitHub 账号已经关联到另一位熊宝用户。请在 GitHub 换一个账号登录后再连接，或联系熊宝管理员。",
    });
  });

  test.each([undefined, "", "slack", "__proto__"])(
    "says nothing for %p",
    (value) => {
      expect(linkedNotice(value)).toBeNull();
    },
  );
});

describe("visibleLinkedNotice", () => {
  const success = linkedNotice("github");
  const github = { provider: "github" as const };
  const slack = { provider: "slack" as const };

  test("shows the success notice while a GitHub link exists", () => {
    expect(visibleLinkedNotice(success, [slack, github])).toEqual(success);
  });

  test("hides the success notice once the GitHub link is gone", () => {
    expect(visibleLinkedNotice(success, [slack])).toBeNull();
    expect(visibleLinkedNotice(success, [])).toBeNull();
  });

  test("hides the success notice until the links have loaded", () => {
    expect(visibleLinkedNotice(success, undefined)).toBeNull();
  });

  test.each(["failed", "github-taken"])(
    "leaves the %s error notice alone whatever the links say",
    (value) => {
      const notice = linkedNotice(value);
      expect(visibleLinkedNotice(notice, [])).toEqual(notice);
      expect(visibleLinkedNotice(notice, undefined)).toEqual(notice);
    },
  );

  test("passes no notice through as none", () => {
    expect(visibleLinkedNotice(null, [github])).toBeNull();
  });
});
