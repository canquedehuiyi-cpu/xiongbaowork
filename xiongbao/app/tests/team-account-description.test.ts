import { expect, test } from "bun:test";
import { teamAccountConnectedDescription } from "@/components/manage/plugin-page";

/*
 * X7 安全评审后，团队账号行（`holder: "deployment"`）的 `displayName` 和 `connectedBy` 只给持有管理员能力的
 * 人，成员和队友拿到 null。拿到 null 时只说「团队账号」，不写「账号是 …」，也不留空白。
 */

test("一个管理员读得到账号名和谁连的，两样都说", () => {
  expect(
    teamAccountConnectedDescription({
      displayName: "ops@example.com",
      connectedBy: "admin@example.com",
    }),
  ).toBe(
    "已连接，团队账号是 ops@example.com，由 admin@example.com 连接。拿到这些工具的每位员工都以这个账号行事。",
  );
});

test("拿到 null 时只说团队账号，没有「账号是」也没有空白", () => {
  const text = teamAccountConnectedDescription({
    displayName: null,
    connectedBy: null,
  });
  expect(text).toBe("已连接团队账号。拿到这些工具的每位员工都以这个账号行事。");
  expect(text).not.toContain("账号是");
  expect(text).not.toContain("由");
  expect(text).not.toMatch(/\s{2}|是\s*[，。]/);
});

test("只拿到其中一样就只说那一样；空串当作没有", () => {
  expect(
    teamAccountConnectedDescription({
      displayName: "  ",
      connectedBy: "a@b.c",
    }),
  ).toBe(
    "已连接团队账号，由 a@b.c 连接。拿到这些工具的每位员工都以这个账号行事。",
  );
  expect(
    teamAccountConnectedDescription({ displayName: "ops", connectedBy: null }),
  ).toBe("已连接，团队账号是 ops。拿到这些工具的每位员工都以这个账号行事。");
});

test("还没有团队账号行（旧服务端不下发）时也照样成句", () => {
  expect(teamAccountConnectedDescription(undefined)).toBe(
    "已连接团队账号。拿到这些工具的每位员工都以这个账号行事。",
  );
});
