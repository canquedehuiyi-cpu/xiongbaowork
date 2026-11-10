import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_ARG,
  accountArgumentFor,
  withAccountArgument,
} from "../src/plugins/account-argument";

/**
 * broker 工具可选的 `account` 参数（上游 `account-argument.ts`，其行为在上游
 * `brokered-multiple-accounts.integration.test.ts` 里经 `grantedTools` 断言；这里先把纯函数钉住）。
 */
const schema = {
  type: "object",
  properties: { query: { type: "string" } },
};
const WORK = "dana@work.example";
const HOME = "dana.home@gmail.example";

describe("the account argument", () => {
  test("is ours only where the action's own schema leaves the name free", () => {
    expect(accountArgumentFor(schema)).toBe(ACCOUNT_ARG);
    expect(accountArgumentFor(undefined)).toBe(ACCOUNT_ARG);
    expect(
      accountArgumentFor({
        type: "object",
        properties: { account: { type: "string" } },
      }),
    ).toBeNull();
  });

  test("is offered only where there is a choice to make", () => {
    expect(withAccountArgument(schema, "Gmail", [])).toBe(schema);
    expect(
      withAccountArgument(schema, "Gmail", [{ label: WORK, isDefault: true }]),
    ).toBe(schema);
  });

  test("names exactly the person's accounts, and which one is the default", () => {
    const offered = withAccountArgument(schema, "Gmail", [
      { label: WORK, isDefault: true },
      { label: HOME, isDefault: false },
    ]) as {
      properties: Record<string, { enum?: string[]; description?: string }>;
      required?: string[];
    };
    expect(offered.properties.query).toEqual({ type: "string" });
    expect(offered.properties.account?.enum).toEqual([WORK, HOME]);
    expect(offered.properties.account?.description).toContain(
      `${WORK} (default)`,
    );
    // 不指定账号仍然合法：它不是必填参数。
    expect(offered.required ?? []).not.toContain(ACCOUNT_ARG);
  });

  test("leaves an action that already has an account parameter alone", () => {
    const own = {
      type: "object",
      properties: { account: { type: "integer" } },
    };
    expect(
      withAccountArgument(own, "Bank", [
        { label: WORK, isDefault: true },
        { label: HOME, isDefault: false },
      ]),
    ).toBe(own);
  });
});
