import { expect, test } from "bun:test";
import { resolveFixture, USER } from "./parity/fixtures";

/* `resolveFixture` 的第五个参数「受众」：默认就是数据集原样（管理员、团队版）。 */

function body(audience?: "admin" | "member" | "personal") {
  const me = resolveFixture("GET", "/api/me", "data", undefined, audience);
  const caps = resolveFixture(
    "GET",
    "/api/capabilities",
    "data",
    undefined,
    audience,
  );
  return {
    me: me?.body as { user: { role: string } },
    caps: caps?.body as { edition: string; localEvaluation: boolean },
  };
}

test("不传受众 = admin：数据集原样", () => {
  const { me, caps } = body();
  expect(me).toEqual({ user: USER });
  expect(me.user.role).toBe("admin");
  expect(caps.edition).toBe("team");
  expect(body("admin")).toEqual(body());
});

test("member：/api/me 的角色改成 user，其余字段不动，能力接口不动", () => {
  const { me, caps } = body("member");
  expect(me).toEqual({ user: { ...USER, role: "user" } });
  expect(caps.edition).toBe("team");
});

test("personal：能力接口的 edition 改成 personal，其余字段不动，/api/me 不动", () => {
  const admin = body("admin");
  const { me, caps } = body("personal");
  expect(caps).toEqual({ ...admin.caps, edition: "personal" });
  expect(me).toEqual(admin.me);
});

test("受众不影响别的接口", () => {
  expect(
    resolveFixture("GET", "/api/agents", "data", undefined, "member"),
  ).toEqual(resolveFixture("GET", "/api/agents", "data"));
});
