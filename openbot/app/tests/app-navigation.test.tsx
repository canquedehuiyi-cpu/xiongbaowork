import { expect, test } from "bun:test";
import {
  AVATAR_MENU_ITEM,
  NAVIGATION,
  navigationFor,
} from "@/lib/navigation";

/*
 * OpenBot's destinations live in one list (`lib/navigation.ts`) that every skin draws from. Admin is
 * in it for admins only.
 *
 * 熊宝版（M5b）按上游的页面结构排，用户拍板的清单：主导航 员工、任务看板、自主工作、@Waker、能力、连接
 * （教员工做事由 `BrowserNavItem` 另画）；「更多」组团流程；账户菜单 我的分身、套餐与用量、设置、管理。
 * 上游「侧栏照这份清单画」、个人版的 OpenBot for Business 用例不收。
 */

test("Admin is in the list for admins only", () => {
  const ids = (role: string | undefined) =>
    navigationFor(role).map((item) => item.id);
  expect(ids("admin")).toEqual(NAVIGATION.map((item) => item.id));
  expect(ids("user")).not.toContain("admin");
  expect(ids(undefined)).not.toContain("admin");
  expect(ids("user")).toEqual([
    "bots",
    "tasks",
    "autonomous",
    "reachability",
    "capabilities",
    "connections",
    "pipelines",
    "plans",
    "settings",
  ]);
});

test("the primary destinations are the six pages the user chose, under their Chinese names", () => {
  expect(
    NAVIGATION.filter((item) => item.section === "primary").map(
      ({ id, label, to }) => ({ id, label, to }),
    ),
  ).toEqual([
    { id: "bots", label: "员工", to: "/bots" },
    { id: "tasks", label: "任务看板", to: "/tasks" },
    { id: "autonomous", label: "自主工作", to: "/autonomous" },
    { id: "reachability", label: "@Waker", to: "/reachability" },
    { id: "capabilities", label: "能力", to: "/capabilities" },
    { id: "connections", label: "连接", to: "/connections" },
  ]);
});

test("组团流程 is folded under 更多", () => {
  expect(
    NAVIGATION.filter((item) => item.section === "more").map(
      ({ id, label, to }) => ({ id, label, to }),
    ),
  ).toEqual([{ id: "pipelines", label: "组团流程", to: "/pipelines" }]);
});

test("the account menu is 我的分身, 套餐与用量, 设置, then 管理 for admins", () => {
  expect(AVATAR_MENU_ITEM).toMatchObject({
    id: "avatar",
    label: "我的分身",
    section: "account",
  });
  expect(
    navigationFor("admin")
      .filter((item) => item.section === "account")
      .map(({ id, label, to }) => ({ id, label, to })),
  ).toEqual([
    { id: "plans", label: "套餐与用量", to: "/settings/plans" },
    { id: "settings", label: "设置", to: "/settings" },
    { id: "admin", label: "管理", to: "/admin" },
  ]);
});

test("the old addresses are gone from the list; they redirect instead", () => {
  const addresses = NAVIGATION.map((item) => item.to as string);
  for (const old of [
    "/wakers",
    "/resources",
    "/settings/connected-accounts",
    "/plans",
    "/routines",
  ]) {
    expect(addresses).not.toContain(old);
  }
});
