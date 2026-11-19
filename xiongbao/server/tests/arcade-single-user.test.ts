import { describe, expect, test } from "bun:test";
import { selectProviderWiring } from "../src/plugins/provider-wiring";

/**
 * 单用户安装（包括个人版）与 Arcade。
 *
 * 上游 #927 并入之前这里钉的是「拒绝启动」：那时每台单用户安装的那个人在 Arcade 都是 `dev-local-user`，
 * 共用一把 ARCADE_API_KEY 的安装互相拿到对方的授权。现在每台安装在 Arcade 那边有自己的名字
 * （`ensureSingleUserIdentity`），所以照上游启用：构造 Arcade 客户端，而且因为单用户安装拥有它的 Arcade
 * 项目，连接之前把项目的验证地址指向自己。Composio 的单用户安装与要登录的部署不变。
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

  test("gets Arcade, and points the project's verifier at itself because the project is its own", () => {
    const f = factories();
    const wiring = selectProviderWiring(
      {
        arcadeApiKey: "arc-secret",
        singleUser: true,
        publicUrl: "http://localhost:3001",
      },
      f.create,
    );
    expect(wiring.provider).toBe("arcade");
    expect(wiring.install.composio).toBeNull();
    expect(f.built).toEqual(["arcade:true"]);
  });

  test("a named Arcade provider is wired the same way, and Composio's client is not built", () => {
    const f = factories();
    const wiring = selectProviderWiring(
      {
        composioApiKey: "c",
        arcadeApiKey: "a",
        brokerProvider: "arcade",
        singleUser: true,
        publicUrl: "http://localhost:3001",
      },
      f.create,
    );
    expect(wiring.provider).toBe("arcade");
    expect(f.built).toEqual(["arcade:true"]);
  });

  test("with no public address there is nothing to point the verifier at, so nothing is repointed", () => {
    const f = factories();
    selectProviderWiring({ arcadeApiKey: "a", singleUser: true }, f.create);
    expect(f.built).toEqual(["arcade:false"]);
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
