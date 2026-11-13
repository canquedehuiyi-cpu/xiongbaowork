/**
 * 技能附件读取的路径清洗与超长分页（Codex 审查意见 #499 之 8、9）。
 *
 * 纯函数级测试，不连数据库：
 *
 *  - 路径清洗的上限必须与加载器（`isSafeSkillAssetPath`，200 字符）一致。修复前读取端用
 *    80 字符截断，81–200 字符的合法附件路径被悄悄截短，读到错的文件或读不到。
 *  - 超 `MAX_RESULT_CHARS` 的附件按 offset/limit 分页，默认行为（一次读 20000 字符）向后
 *    兼容；修复后半段内容通过续读 offset 可达，不再永久丢失。
 */
import { describe, expect, test } from "bun:test";
import { cleanSkillAssetPath, paginateAssetContent } from "../src/skills/read-tool";

describe("cleanSkillAssetPath", () => {
  test("81–200 字符的合法路径原样通过，不再被 80 字符截断", () => {
    const path = `references/${"a".repeat(141)}/step.md`;
    expect(path.length).toBe(160);
    expect(cleanSkillAssetPath(path)).toBe(path);
  });

  test("恰好 200 字符（加载器上限）的路径原样通过", () => {
    const path = `references/${"b".repeat(181)}/file.md`;
    expect(path.length).toBe(200);
    expect(cleanSkillAssetPath(path)).toBe(path);
  });

  test("控制字符仍然被清洗（与技能 id 清洗同一规则）", () => {
    expect(cleanSkillAssetPath("references/\u0000x/step.md")).toBe("references/ x/step.md");
  });

  test("超过 200 字符的路径截到 200（交给 isSafeSkillAssetPath 之前的统一上限）", () => {
    const path = `references/${"c".repeat(220)}/file.md`;
    expect(cleanSkillAssetPath(path).length).toBe(200);
  });
});

describe("paginateAssetContent", () => {
  const total = 45_000;
  const content = Array.from({ length: total }, (_, i) => String.fromCharCode(65 + (i % 26))).join("");

  test("默认窗口（20000 字符）向后兼容：第一段是前 20000 个字符，并给出续读 offset", () => {
    const page = paginateAssetContent(content, 0, 20_000);
    expect(page.totalChars).toBe(total);
    expect(page.text).toBe(content.slice(0, 20_000));
    expect(page.nextOffset).toBe(20_000);
  });

  test("续读窗口返回后半段：修复前这段内容永远读不到", () => {
    const page = paginateAssetContent(content, 20_000, 20_000);
    expect(page.text).toBe(content.slice(20_000, 40_000));
    expect(page.nextOffset).toBe(40_000);
  });

  test("最后一段读完时 nextOffset 为 null", () => {
    const page = paginateAssetContent(content, 40_000, 20_000);
    expect(page.text).toBe(content.slice(40_000));
    expect(page.nextOffset).toBeNull();
  });

  test("offset 超出全文时返回空窗口", () => {
    const page = paginateAssetContent(content, 50_000, 20_000);
    expect(page.text).toBe("");
    expect(page.nextOffset).toBeNull();
  });

  test("不足一窗的内容不分页", () => {
    const page = paginateAssetContent("短内容。", 0, 20_000);
    expect(page.text).toBe("短内容。");
    expect(page.nextOffset).toBeNull();
    expect(page.totalChars).toBe(4);
  });
});
