import { expect, test } from "bun:test";
import { NAVIGATION, navigationFor } from "@/lib/navigation";

/*
 * OpenBot's destinations live in one list (`lib/navigation.ts`) that every skin draws from. Admin is
 * in it for admins only.
 *
 * 熊宝版保留自己的侧栏（员工/群组信息架构），上游「侧栏照这份清单画」以及个人版、OpenBot for Business
 * 的用例不收。
 */

test("Admin is in the list for admins only", () => {
  const ids = (role: string | undefined) =>
    navigationFor(role).map((item) => item.id);
  expect(ids("admin")).toEqual(NAVIGATION.map((item) => item.id));
  expect(ids("user")).not.toContain("admin");
  expect(ids(undefined)).not.toContain("admin");
  expect(ids("user")).toEqual([
    "bots",
    "capabilities",
    "connections",
    "settings",
  ]);
});
