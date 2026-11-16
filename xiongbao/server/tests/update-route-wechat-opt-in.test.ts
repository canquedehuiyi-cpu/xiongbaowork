import { expect, test } from "bun:test";
import { OPT_IN_TRANSPORTS, routeAllows } from "../src/agents/lifecycle";

/** 用户 2026-11-16 决定：绑定微信不会自动往微信发任何通知，"all" 不含微信，要本人打开才发。 */
test("没有路由行（all）：微信不发，其它渠道照旧", () => {
  expect(OPT_IN_TRANSPORTS).toEqual(["wechat"]);
  expect(routeAllows("all", "wechat")).toBe(false);
  for (const transport of ["slack", "teams", "sms", "push"] as const)
    expect(routeAllows("all", transport)).toBe(true);
});

test("显式列表：只有列出的才发，列了微信才发微信", () => {
  expect(routeAllows(["push", "wechat"], "wechat")).toBe(true);
  expect(routeAllows(["push"], "wechat")).toBe(false);
  expect(routeAllows(["push"], "slack")).toBe(false);
});
