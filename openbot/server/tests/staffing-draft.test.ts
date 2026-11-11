import { describe, expect, test } from "bun:test";
import { parseDraft } from "../src/staffing/draft";
import { versionOfEmployee, versionOfGroup } from "../src/staffing/version";

const employee = (over: Record<string, unknown> = {}) => ({
  name: "小红",
  title: "客服",
  roleDescription: "回答客户问题",
  ...over,
});

describe("employee drafts", () => {
  test("an employee draft keeps the CreateAgentInput limits", () => {
    expect(parseDraft("employee", employee({ name: "a".repeat(81) })).ok).toBe(
      false,
    );
    expect(parseDraft("employee", employee({ name: "a".repeat(80) })).ok).toBe(
      true,
    );
    expect(
      parseDraft("employee", employee({ title: "a".repeat(121) })).ok,
    ).toBe(false);
    expect(parseDraft("employee", employee({ roleDescription: "" })).ok).toBe(
      false,
    );
    expect(
      parseDraft("employee", employee({ roleDescription: "a".repeat(1000) }))
        .ok,
    ).toBe(true);
    expect(
      parseDraft("employee", employee({ roleDescription: "a".repeat(1001) }))
        .ok,
    ).toBe(false);
    expect(
      parseDraft("employee", employee({ instructions: "a".repeat(1001) })).ok,
    ).toBe(false);
    expect(
      parseDraft("employee", employee({ bible: "a".repeat(8000) })).ok,
    ).toBe(true);
    expect(
      parseDraft("employee", employee({ bible: "a".repeat(8001) })).ok,
    ).toBe(false);
  });

  test("a missing optional part gets its default", () => {
    const parsed = parseDraft("employee", employee());
    expect(parsed).toEqual({
      ok: true,
      dropped: [],
      draft: {
        name: "小红",
        title: "客服",
        roleDescription: "回答客户问题",
        skills: [],
        apps: [],
        routines: [],
        visibility: "private",
        staffingTools: false,
      },
    });
  });

  test("control characters are removed from names and text", () => {
    const parsed = parseDraft(
      "employee",
      employee({ name: "小\u0007红", roleDescription: "第一行\n第\u0000二行" }),
    );
    expect(parsed.ok && parsed.draft).toMatchObject({
      name: "小红",
      roleDescription: "第一行\n第二行",
    });
  });

  test("an avatar preset outside the five is refused", () => {
    expect(
      parseDraft("employee", employee({ avatar: { preset: "cute" } })).ok,
    ).toBe(true);
    expect(
      parseDraft("employee", employee({ avatar: { preset: "scary" } })).ok,
    ).toBe(false);
  });

  test("a model names one source only", () => {
    expect(
      parseDraft(
        "employee",
        employee({ model: { modelRef: "a", platformModelRef: "b" } }),
      ).ok,
    ).toBe(false);
  });

  test("a routine below fifteen minutes is dropped with its reason", () => {
    const parsed = parseDraft(
      "employee",
      employee({
        routines: [
          { instruction: "查库存", cron: "*/5 * * * *" },
          {
            instruction: "发日报",
            cron: "0 9 * * *",
            timezone: "Asia/Shanghai",
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dropped).toHaveLength(1);
    expect(parsed.dropped[0]).toMatchObject({
      field: "routines",
      value: "*/5 * * * *",
    });
    expect(parsed.dropped[0]?.reason.length).toBeGreaterThan(0);
    expect((parsed.draft as { routines: unknown[] }).routines).toHaveLength(1);
  });

  test("a routine with an unknown timezone or an empty instruction is dropped", () => {
    const parsed = parseDraft(
      "employee",
      employee({
        routines: [
          { instruction: "a", cron: "0 9 * * *", timezone: "Mars/Base" },
          { instruction: "", cron: "0 9 * * *" },
        ],
      }),
    );
    expect(parsed.ok && parsed.dropped).toHaveLength(2);
  });
});

describe("employee changes", () => {
  test("a change with nothing to change is refused", () => {
    expect(parseDraft("employee_change", { agentId: "a1" }).ok).toBe(false);
  });

  test("only the given fields are kept and validated", () => {
    const parsed = parseDraft("employee_change", {
      agentId: "a1",
      set: { title: "主管" },
    });
    expect(parsed).toEqual({
      ok: true,
      dropped: [],
      draft: {
        agentId: "a1",
        set: { title: "主管" },
        appsRemove: [],
        routinesRemove: [],
      },
    });
    expect(
      parseDraft("employee_change", {
        agentId: "a1",
        set: { name: "a".repeat(81) },
      }).ok,
    ).toBe(false);
  });
});

describe("group drafts", () => {
  test("a group needs two to twenty distinct members", () => {
    const members = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
    expect(parseDraft("group", { name: "群", members: members(1) }).ok).toBe(
      false,
    );
    expect(parseDraft("group", { name: "群", members: ["a", "a"] }).ok).toBe(
      false,
    );
    expect(parseDraft("group", { name: "群", members: members(21) }).ok).toBe(
      false,
    );
    expect(parseDraft("group", { name: "群", members: members(2) }).ok).toBe(
      true,
    );
    expect(parseDraft("group", { name: "群", members: members(20) }).ok).toBe(
      true,
    );
  });

  test("a group change cannot add and remove the same member", () => {
    expect(
      parseDraft("group_change", { channelId: "c", add: ["a"], remove: ["a"] })
        .ok,
    ).toBe(false);
    expect(parseDraft("group_change", { channelId: "c" }).ok).toBe(false);
    expect(
      parseDraft("group_change", { channelId: "c", name: "新名" }).ok,
    ).toBe(true);
  });
});

describe("versions", () => {
  test("a rename or reorder changes the group version and identical input does not", () => {
    const base = versionOfGroup({ name: "群", order: ["a", "b"] });
    expect(versionOfGroup({ name: "群", order: ["a", "b"] })).toBe(base);
    expect(versionOfGroup({ name: "新群", order: ["a", "b"] })).not.toBe(base);
    expect(versionOfGroup({ name: "群", order: ["b", "a"] })).not.toBe(base);
  });

  test("an employee version is the update time", () => {
    const at = new Date("2026-11-11T08:00:00.000Z");
    expect(versionOfEmployee({ updatedAt: at })).toBe(
      "2026-11-11T08:00:00.000Z",
    );
  });
});
