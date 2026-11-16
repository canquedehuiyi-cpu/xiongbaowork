/**
 * 连接器悬空 ref 清理的 LIKE 通配符转义（Codex 审查意见 #499 之 7）。
 *
 * 纯函数级测试：不连数据库，直接断言模式转义与渲染出的 SQL。修复前连接器 id 原样进入
 * LIKE 模式，`my_app/%` 里的 `_` 是单字符通配符，会把 `my-app/…`（以及任何
 * `myXapp/…`）的授权一并删掉——而且是跨租户的整表删除。修复后 id 是数据不是模式。
 */
import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { pluginGrants } from "../src/db/schema";
import { escapeLikePattern, refPrefixPredicate } from "../src/tenant-package-capabilities";

describe("escapeLikePattern", () => {
  test("转义 LIKE 的三个通配符：反斜杠、百分号、下划线", () => {
    expect(escapeLikePattern("my_app")).toBe("my\\_app");
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    expect(escapeLikePattern("my-app")).toBe("my-app");
    expect(escapeLikePattern("pkg.conn/v1")).toBe("pkg.conn/v1");
  });
});

describe("refPrefixPredicate", () => {
  const dialect = new PgDialect();

  test("参数里的 id 通配符已转义，并带上 ESCAPE 子句", () => {
    const query = dialect.sqlToQuery(refPrefixPredicate(pluginGrants.ref, "my_app"));
    expect(query.sql.toLowerCase()).toContain("escape");
    // `my_app` 的 `_` 必须以字面量进入模式，而不是单字符通配符。
    expect(query.params[0]).toBe("my\\_app/%");
  });

  test("不含通配符的 id 行为不变", () => {
    const query = dialect.sqlToQuery(refPrefixPredicate(pluginGrants.ref, "pkg-connector-ab12cd34"));
    expect(query.params[0]).toBe("pkg-connector-ab12cd34/%");
  });
});
