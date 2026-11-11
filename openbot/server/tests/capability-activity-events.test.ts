import { describe, expect, test } from "bun:test";
import { AUDIT_EVENT_WORDS } from "@openbot/shared/audit-words";
import { CAPABILITY_ACTIVITY } from "../src/admin/capability-changes";
import { auditEventTypes } from "../src/audit";

/*
 * 管理员改权限前看到的「最近用过」按审计事件数（`admin/capability-changes.ts`）。每个被数的事件都必须是这个
 * 部署真的会写的事件、并有中文说法，否则那一栏永远是 0，管理员会以为关掉一个权限不影响任何人。
 *
 * 「把自己的应用给自己的员工」（ownerApps）数的是 `app_access.owner_granted`：M5a 只在 audit.ts 里留了位置，
 * X3 合入后才写这个事件（主人经 `/give` 给员工应用时）。
 */
const counted = Object.entries(CAPABILITY_ACTIVITY).flatMap(
  ([capability, mapping]) =>
    (mapping?.query.eventType ?? "")
      .split(",")
      .filter(Boolean)
      .map((eventType) => ({ capability, eventType })),
);

describe("what the capability preview counts", () => {
  test("every event it counts is one this deployment writes", () => {
    const known = new Set<string>(auditEventTypes);
    expect(counted.filter(({ eventType }) => !known.has(eventType))).toEqual(
      [],
    );
  });

  test("every event it counts has words for the reader", () => {
    expect(
      counted.filter(({ eventType }) => !AUDIT_EVENT_WORDS[eventType]),
    ).toEqual([]);
  });

  test("an owner giving their own app is counted for ownerApps, and taking it back has words too", () => {
    expect(counted).toContainEqual({
      capability: "ownerApps",
      eventType: "app_access.owner_granted",
    });
    expect(auditEventTypes).toContain("app_access.owner_revoked");
    expect(AUDIT_EVENT_WORDS["app_access.owner_revoked"]).toBeTruthy();
  });
});
