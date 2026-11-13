import { describe, expect, test } from "bun:test";
import { validateTenantPackage } from "../src/tenant-package";

/**
 * P4（能力与资源页面并联）的数据链第一环：`skills.yaml` 每条技能的 `runnable` 档位
 * （`full | degraded | blocked`，移植方案 §R3 ——「manifest.runnable 必填 + UI 徽章」）
 * 必须被装包解析带出来，落到 `TenantSkill.runnable`，后面的同步、API 下发和徽章都读它。
 *
 * 缺省是 `full`：包写全了档位是移植管道的义务（校验器盯着），手工写的包没写就是完整移植——
 * 行为与没有这一环的旧包完全一致。写错档位拒绝整个包：一个假「能跑」的技能正是 R3 要防的。
 */
function packageWithSkills(skillsYaml: string) {
  return validateTenantPackage({
    brand: "tenant: { id: openbot, product_name: P }",
    agents: "agents: []",
    channels: "channels: []",
    model:
      "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
    knowledge: "sources: []",
    themeCss: "",
    skills: skillsYaml,
  });
}

const oneSkill = (runnableYaml: string | null) =>
  [
    "skills:",
    "  - slug: sample-skill",
    "    title: 样例技能",
    "    summary: 一行说明。",
    "    instructions: 做事的方法。",
    ...(runnableYaml === null ? [] : [`    runnable: ${runnableYaml}`]),
  ].join("\n");

describe("tenant package skill runnable grades", () => {
  test("each declared grade is carried through", () => {
    for (const grade of ["full", "degraded", "blocked"] as const) {
      const loaded = packageWithSkills(oneSkill(`"${grade}"`));
      expect(loaded.skills).toHaveLength(1);
      expect(loaded.skills[0]?.runnable).toBe(grade);
    }
  });

  test("absent reads as full, so a package written before the grade ships unchanged", () => {
    const loaded = packageWithSkills(oneSkill(null));
    expect(loaded.skills[0]?.runnable).toBe("full");
  });

  test("an unknown grade refuses the whole package, naming the field", () => {
    for (const bad of ['"Full"', '"partial"', '"ok"', '""']) {
      expect(() => packageWithSkills(oneSkill(bad))).toThrow(/runnable/);
    }
  });

  test("a non-string grade refuses the package", () => {
    expect(() => packageWithSkills(oneSkill("1"))).toThrow(/runnable/);
    expect(() => packageWithSkills(oneSkill("true"))).toThrow(/runnable/);
  });

  /*
   * The ported package's shape: the assembler writes the grade under `_porting` (mirroring the
   * manifest row), not at the top level. Reading only the top level silently upgraded every
   * audited-blocked skill to `full` — found by the port-l0 end-to-end chain, not by these
   * fixtures, which is exactly why the chain exists (P5).
   */
  test("the assembler's _porting.runnable is carried through", () => {
    const loaded = packageWithSkills(
      [
        "skills:",
        "  - slug: sample-skill",
        "    title: 样例技能",
        "    summary: 一行说明。",
        "    instructions: 做事的方法。",
        "    tools: []",
        "    _porting:",
        "      source: xiongbao-package",
        "      runnable: blocked",
      ].join("\n"),
    );
    expect(loaded.skills[0]?.runnable).toBe("blocked");
  });

  test("an explicit top-level grade overrides the audit block", () => {
    const loaded = packageWithSkills(
      [
        "skills:",
        "  - slug: sample-skill",
        "    title: 样例技能",
        "    summary: 一行说明。",
        "    instructions: 做事的方法。",
        "    runnable: full",
        "    _porting:",
        "      runnable: blocked",
      ].join("\n"),
    );
    expect(loaded.skills[0]?.runnable).toBe("full");
  });

  test("an unknown grade under _porting refuses the package too", () => {
    expect(() =>
      packageWithSkills(
        [
          "skills:",
          "  - slug: sample-skill",
          "    title: 样例技能",
          "    summary: 一行说明。",
          "    instructions: 做事的方法。",
          "    _porting:",
          "      runnable: probably-fine",
        ].join("\n"),
      ),
    ).toThrow(/runnable/);
  });
});
