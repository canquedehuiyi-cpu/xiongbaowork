import { describe, expect, test } from "bun:test";
import {
  accountFor,
  asAccountMode,
  DEPLOYMENT_VENDOR_PREFIX,
  filedUnderPerson,
  mintDeploymentVendorUserId,
  personAccount,
} from "../src/plugins/shared-accounts";

/**
 * 上游 `server/tests/shared-accounts.test.ts`，按 fork 改写：
 * - Arcade 的三条在 X5 并入 Arcade 时带回（fork 现在只有 Composio 一个 broker），这里改为断言 fork 不把
 *   `arcade` 当作 broker 行。
 * - 拒绝的句子是中文，仍然点出应用名。
 */

const brokered = (
  accountMode: string | null,
  authScheme: string | null = "OAUTH2",
) => ({
  title: "GitHub",
  provenance: "composio",
  authScheme,
  accountMode,
});

describe("accountFor", () => {
  test("a personal app is reached as whoever the credential actor is", () => {
    expect(accountFor(brokered("personal"), "user_a")).toEqual({
      kind: "person",
      userId: "user_a",
    });
  });

  test("a shared app is reached as the deployment whatever the credential actor", () => {
    expect(accountFor(brokered("shared"), "user_a")).toEqual({
      kind: "deployment",
    });
    expect(accountFor(brokered("shared"), "owner_of_team_bot")).toEqual({
      kind: "deployment",
    });
  });

  test("an app needing no account has no account in either mode", () => {
    expect(accountFor(brokered(null, "NO_AUTH"), "user_a")).toEqual({
      kind: "none",
    });
    expect(accountFor(brokered("shared", "NO_AUTH"), "user_a")).toEqual({
      kind: "none",
    });
  });

  test("a brokered app needing an account with no mode is refused, not guessed", () => {
    const answer = accountFor(brokered(null), "user_a");
    expect(answer.kind).toBe("ambiguous");
    if (answer.kind === "ambiguous") expect(answer.message).toMatch(/GitHub/);
  });

  test("a mode that is not one of the two is refused, not guessed", () => {
    expect(accountFor(brokered("team"), "user_a").kind).toBe("ambiguous");
  });

  test("an unreadable scheme is treated as having an account, the closed direction", () => {
    expect(accountFor(brokered("shared", null), "user_a")).toEqual({
      kind: "deployment",
    });
    expect(accountFor(brokered("personal", "SOMETHING_NEW"), "user_a")).toEqual(
      { kind: "person", userId: "user_a" },
    );
  });

  test("a non-brokered row has no account", () => {
    expect(
      accountFor({ ...brokered("personal"), provenance: "manual" }, "user_a"),
    ).toEqual({ kind: "none" });
    // X5 起 Arcade 也是 fork 的 broker：它的应用和 Composio 一样有账号。
    expect(
      accountFor({ ...brokered("personal"), provenance: "arcade" }, "user_a"),
    ).toEqual({ kind: "person", userId: "user_a" });
  });
});

describe("asAccountMode", () => {
  test("reads the two modes and nothing else", () => {
    expect(asAccountMode("personal")).toBe("personal");
    expect(asAccountMode("shared")).toBe("shared");
    expect(asAccountMode("Shared")).toBeNull();
    expect(asAccountMode(undefined)).toBeNull();
  });
});

describe("mintDeploymentVendorUserId", () => {
  test("names the deployment and carries a random part", () => {
    expect(mintDeploymentVendorUserId("acme", () => "R4nd0m")).toBe(
      `${DEPLOYMENT_VENDOR_PREFIX}acme:R4nd0m`,
    );
  });

  test("two mints for the same deployment differ", () => {
    expect(mintDeploymentVendorUserId("acme")).not.toBe(
      mintDeploymentVendorUserId("acme"),
    );
  });

  test("refuses a blank deployment id rather than minting a shared namespace", () => {
    expect(() => mintDeploymentVendorUserId("  ")).toThrow(/deployment/);
  });
});

describe("a person's account", () => {
  test("is filed under their own id unless a name was read for them", () => {
    expect(personAccount("user_a", null)).toEqual({
      holder: "person",
      userId: "user_a",
      vendorUserId: "user_a",
    });
    expect(personAccount("user_a", "filed-elsewhere").vendorUserId).toBe(
      "filed-elsewhere",
    );
  });

  test("a further id of theirs is filed under them, and nobody else's is", () => {
    expect(filedUnderPerson("user_a", "user_a")).toBe(true);
    expect(filedUnderPerson("user_a~1f2e", "user_a")).toBe(true);
    expect(filedUnderPerson("user_ab", "user_a")).toBe(false);
    expect(filedUnderPerson("user_a~", "user_a")).toBe(false);
    expect(filedUnderPerson("user_a~x~y", "user_a")).toBe(false);
    expect(filedUnderPerson("user_b", "user_a")).toBe(false);
  });
});
