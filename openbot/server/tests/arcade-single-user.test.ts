import { describe, expect, test } from "bun:test";
import { selectProviderWiring } from "../src/plugins/provider-wiring";

/**
 * fork X5 评审 I2：上游 #927（单用户安装在厂商那边有自己的名字）并入之前，单用户安装一律不启用 Arcade。
 *
 * 单用户安装的那个人在每台机器上都是 `dev-local-user`。几台安装共用一把 ARCADE_API_KEY 时，一台连接的
 * Gmail 另一台的 Bot 就能调用；而且每台每次连接前都会把项目的验证地址改成自己。所以既不构造 Arcade
 * 客户端，也不改写验证地址，启动时用中文说明。Composio 的单用户安装不受影响（行为与以前一样）。
 */
describe("a single-user install and Arcade", () => {
  const factories = () => {
    const built: string[] = [];
    return {
      built,
      create: {
        composio: () => {
          built.push("composio");
          return { actions: {}, broker: {} };
        },
        arcade: (_key: string, options: { repointVerifier?: boolean }) => {
          built.push(`arcade:${options.repointVerifier === true}`);
          return { actions: {}, broker: {} };
        },
      },
    };
  };

  test("refuses to start rather than share one Arcade name across installs", () => {
    const f = factories();
    let refusal = "";
    try {
      selectProviderWiring(
        {
          arcadeApiKey: "arc-secret",
          singleUser: true,
          publicUrl: "http://localhost:3001",
        },
        f.create,
      );
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain("单用户");
    expect(refusal).toContain("Arcade");
    expect(refusal).not.toContain("arc-secret");
    // 没有构造客户端，所以也没有任何一次改写验证地址。
    expect(f.built).toEqual([]);
  });

  test("a named Arcade provider is refused the same way", () => {
    const f = factories();
    expect(() =>
      selectProviderWiring(
        {
          composioApiKey: "c",
          arcadeApiKey: "a",
          brokerProvider: "arcade",
          singleUser: true,
        },
        f.create,
      ),
    ).toThrow(/单用户/);
    expect(f.built).toEqual([]);
  });

  test("a single-user Composio install is untouched", () => {
    const f = factories();
    const wiring = selectProviderWiring(
      { composioApiKey: "c", singleUser: true },
      f.create,
    );
    expect(wiring.provider).toBe("composio");
    expect(f.built).toEqual(["composio"]);
  });

  test("a deployment that signs people in still gets Arcade, never repointing the verifier", () => {
    const f = factories();
    const wiring = selectProviderWiring(
      { arcadeApiKey: "a", publicUrl: "https://openbot.example" },
      f.create,
    );
    expect(wiring.provider).toBe("arcade");
    expect(f.built).toEqual(["arcade:false"]);
  });
});
