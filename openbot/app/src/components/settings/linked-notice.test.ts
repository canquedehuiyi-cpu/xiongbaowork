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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
      text: "GitHub 账号没能关联，请再试一次。",
=======
      text: "Couldn't link your GitHub account. Try again.",
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    });
  });

  test("tells the person the GitHub account belongs to another user, as an alert", () => {
    expect(linkedNotice("github-taken")).toEqual({
      tone: "error",
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
      text: "这个 GitHub 账号已经关联到另一位熊宝用户。请在 GitHub 换一个账号登录后再连接，或联系熊宝管理员。",
=======
      text: "That GitHub account is linked to someone else in OpenBot. Sign in to GitHub with another account and try again, or ask an admin.",
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
