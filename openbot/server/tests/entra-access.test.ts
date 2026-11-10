import { describe, expect, test } from "bun:test";
import {
  type EntraRefusal,
  EntraTokenRefusedError,
} from "../src/auth/entra-refusal";
import { accessFor } from "../src/plugins/access";
import { catalogueEntry } from "../src/plugins/catalogue";
import {
  decideEntraScope,
  entraRefusalSentence,
  entraTokenFor,
} from "../src/plugins/entra-access";

/**
 * 以登录人身份访问的自定义 MCP 服务器（上游 #931）：不碰数据库的那一半。
 *
 * `accessFor` 把标了 scope 的按 URL 添加的服务器解析成本人的凭据；`decideEntraScope` 决定一次添加之后
 * scope 是什么、什么时候拒绝；`entraTokenFor` 把 Entra 的每种拒绝换成本人看得懂的中文。和数据库、
 * 替身 Entra 一起跑的那一半在 `entra-obo-servers.integration.test.ts`。
 */

const HR = "api://hr-api/.default";
const refuse = (sentence: string) => new Error(sentence);

describe("accessFor", () => {
  test("a server added by URL and marked with an Entra scope is MCP, on the asking person's own Microsoft sign-in", () => {
    expect(
      accessFor(
        {
          provenance: "custom",
          url: "https://hr.example.com/mcp",
          authScheme: null,
          entraScope: HR,
        },
        null,
      ),
    ).toEqual({
      transport: "mcp",
      credential: "person-entra",
      reachedAs: "person",
      toolkit: null,
    });
  });

  test("the same server with no scope, or an empty one, is still on the deployment's token", () => {
    for (const entraScope of [null, undefined, ""]) {
      expect(
        accessFor(
          {
            provenance: "custom",
            url: "https://hr.example.com/mcp",
            authScheme: null,
            entraScope,
          },
          null,
        ).credential,
      ).toBe("deployment-token");
    }
  });

  test("a stray scope on a catalogue server or a brokered app changes nothing", () => {
    const notion = catalogueEntry("notion");
    expect(notion).not.toBeNull();
    expect(
      accessFor(
        {
          provenance: "first-party",
          url: "https://mcp.notion.com/mcp",
          authScheme: null,
          entraScope: HR,
        },
        notion,
      ).credential,
    ).toBe("person-oauth");
    expect(
      accessFor(
        {
          provenance: "composio",
          url: "composio://gmail",
          authScheme: "OAUTH2",
          entraScope: HR,
        },
        null,
      ).credential,
    ).toBe("brokered");
  });
});

describe("decideEntraScope", () => {
  const url = "https://hr.example.com/mcp";
  /**
   * A decision as words, so "not named" and "no scope" are asserted rather than left to an
   * expected `undefined`, which `toEqual` would accept from a decision missing the key altogether.
   */
  const read = (decision: ReturnType<typeof decideEntraScope>) =>
    "refusal" in decision
      ? decision
      : {
          named: decision.named === undefined ? "not named" : decision.named,
          scope: decision.scope === undefined ? "no scope" : decision.scope,
        };

  test("a named scope marks the server, trimmed", () => {
    expect(
      decideEntraScope(
        { id: "hr", url, entraScope: `  ${HR} ` },
        undefined,
        true,
      ),
    ).toEqual({ named: HR, scope: HR });
  });

  test("naming none keeps the mark a server already has", () => {
    expect(
      read(decideEntraScope({ id: "hr", url }, { url, entraScope: HR }, true)),
    ).toEqual({ named: "not named", scope: HR });
  });

  test("null takes the mark off", () => {
    expect(
      read(
        decideEntraScope(
          { id: "hr", url, entraScope: null },
          { url, entraScope: HR },
          true,
        ),
      ),
    ).toEqual({ named: null, scope: "no scope" });
  });

  test("marking is refused where Microsoft sign-in is not set up", () => {
    expect(
      decideEntraScope({ id: "hr", url, entraScope: HR }, undefined, false),
    ).toEqual({
      refusal:
        "还没有配置 Microsoft 登录，所以不能把服务器设为以登录人的身份访问。请先设置 MICROSOFT_OAUTH_CLIENT_ID 和 MICROSOFT_OAUTH_CLIENT_SECRET。",
    });
  });

  test("a token beside a scope is refused, in words that say how to switch", () => {
    expect(
      decideEntraScope(
        { id: "hr", url, entraScope: HR, credentialId: "cred" },
        undefined,
        true,
      ),
    ).toEqual({
      refusal:
        "以登录人的身份访问的服务器使用本人的 Microsoft 登录，不收令牌。",
    });
    expect(
      decideEntraScope(
        { id: "hr", url, credentialId: "cred" },
        { url, entraScope: HR },
        true,
      ),
    ).toEqual({
      refusal:
        "hr 以登录人的身份访问，不收令牌。要改用令牌访问，请同时把 entraScope 设为 null。",
    });
  });

  test("more than one scope, or one too long to be a scope, is refused", () => {
    for (const entraScope of [`${HR} api://payroll/.default`, "a".repeat(257)])
      expect(
        decideEntraScope({ id: "hr", url, entraScope }, undefined, true),
      ).toEqual({
        refusal: "请只填一个 Entra scope，例如 api://hr-api/.default。",
      });
  });

  test("a marked server is not moved to another address, nor marked while moving", () => {
    const moved = "https://elsewhere.example.com/mcp";
    const refusal = {
      refusal:
        "hr 以登录人的身份访问，已经在另一个地址。要换地址，请先移除再重新添加。",
    };
    expect(
      decideEntraScope({ id: "hr", url: moved }, { url, entraScope: HR }, true),
    ).toEqual(refusal);
    expect(
      decideEntraScope(
        { id: "hr", url: moved, entraScope: null },
        { url, entraScope: HR },
        true,
      ),
    ).toEqual(refusal);
    expect(
      decideEntraScope(
        { id: "hr", url: moved, entraScope: HR },
        { url, entraScope: null },
        true,
      ),
    ).toEqual(refusal);
    // An unmarked server moving is the deployment-token rule's business, not this one's.
    expect(
      read(
        decideEntraScope(
          { id: "hr", url: moved },
          { url, entraScope: null },
          true,
        ),
      ),
    ).toEqual({ named: "not named", scope: "no scope" });
  });
});

describe("entraTokenFor", () => {
  const row = { title: "HR", entraScope: HR };

  test("hands back the token Entra issued for the person and this scope", async () => {
    const asked: [string, string][] = [];
    const token = await entraTokenFor(
      {
        tokenFor: async (userId, scope) => {
          asked.push([userId, scope]);
          return "obo-token";
        },
      },
      row,
      "user-1",
      refuse,
    );
    expect(token).toBe("obo-token");
    expect(asked).toEqual([["user-1", HR]]);
  });

  test("a run attributed to nobody, and a deployment with no Microsoft sign-in, never ask Entra", async () => {
    let asked = 0;
    const tokens = {
      tokenFor: async () => {
        asked += 1;
        return "obo-token";
      },
    };
    await expect(entraTokenFor(tokens, row, "", refuse)).rejects.toThrow(
      "「HR」以提问人的身份访问，而这次运行没有归属到任何人。",
    );
    await expect(
      entraTokenFor(undefined, row, "user-1", refuse),
    ).rejects.toThrow(
      "「HR」需要 Microsoft 登录，但这里还没有配置。请联系管理员配置。",
    );
    expect(asked).toBe(0);
  });

  test.each([
    ["not-admitted", "你已经不能使用 OpenBot，所以没有使用「HR」。"],
    [
      "no-sign-in",
      "「HR」要用你的 Microsoft 账号，但 OpenBot 还没有你的 Microsoft 登录。请先在浏览器里用 Microsoft 登录 OpenBot 一次，再重新提问。",
    ],
    [
      "sign-in-expired",
      "你的 Microsoft 登录已过期，所以没有使用「HR」。请重新用 Microsoft 登录后再提问。",
    ],
    [
      "no-consent",
      "管理员还没有在 Microsoft Entra 里授权 OpenBot 访问「HR」。请联系管理员授权。",
    ],
    [
      "no-api-consent",
      "OpenBot 在 Microsoft Entra 里还没有获得对它自己 API 的授权，所以无法以你的身份访问「HR」。请联系管理员授权。",
    ],
    [
      "no-api",
      "OpenBot 在 Microsoft Entra 里还没有设置好，无法以你的身份访问「HR」。请管理员在那里公开 OpenBot 的 API。",
    ],
    [
      "refused",
      "Microsoft 不允许 OpenBot 以你的身份访问「HR」。请稍后再试；如果一直这样，请联系管理员。",
    ],
  ] as const)(
    "Entra's %s reads as a plain sentence",
    async (reason, sentence) => {
      expect(entraRefusalSentence(reason as EntraRefusal, "HR")).toBe(sentence);
      await expect(
        entraTokenFor(
          {
            tokenFor: async () => {
              throw new EntraTokenRefusedError(
                reason,
                "Microsoft would not issue the token (400, invalid_grant).",
              );
            },
          },
          row,
          "user-1",
          refuse,
        ),
      ).rejects.toThrow(sentence);
    },
  );

  test("anything that is not Entra refusing goes on as it came", async () => {
    const fault = new TypeError("fetch failed");
    await expect(
      entraTokenFor(
        {
          tokenFor: async () => {
            throw fault;
          },
        },
        row,
        "user-1",
        refuse,
      ),
    ).rejects.toBe(fault);
  });
});
