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
  forbiddenResource,
  openBotResources,
  parseOboResources,
  scopeBindingRefusal,
  scopeResource,
} from "../src/plugins/entra-access";

/**
 * 以登录人身份访问的自定义 MCP 服务器（上游 #931）：不碰数据库的那一半。
 *
 * `accessFor` 把标了 scope 的按 URL 添加的服务器解析成本人的凭据；`decideEntraScope` 决定一次添加之后
 * scope 是什么、什么时候拒绝；`entraTokenFor` 把 Entra 的每种拒绝换成本人看得懂的中文。和数据库、
 * 替身 Entra 一起跑的那一半在 `entra-obo-servers.integration.test.ts`。
 */

const HR = "api://hr-api/.default";
const HR_URL = "https://hr.example.com/mcp";
const OPENBOT = "6e74172b-be56-4843-9ff4-e66a39bb12e3";
/** What a deployment registered: the HR API, bound to the HR system's host. */
const BINDING = {
  resources: [{ resource: "api://hr-api", host: "hr.example.com" }],
  own: openBotResources(OPENBOT, `api://${OPENBOT}/.default`),
};
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
        BINDING,
      ),
    ).toEqual({ named: HR, scope: HR });
  });

  test("naming none keeps the mark a server already has", () => {
    expect(
      read(
        decideEntraScope({ id: "hr", url }, { url, entraScope: HR }, BINDING),
      ),
    ).toEqual({ named: "not named", scope: HR });
  });

  test("null takes the mark off", () => {
    expect(
      read(
        decideEntraScope(
          { id: "hr", url, entraScope: null },
          { url, entraScope: HR },
          BINDING,
        ),
      ),
    ).toEqual({ named: null, scope: "no scope" });
  });

  test("marking is refused where Microsoft sign-in is not set up", () => {
    expect(
      decideEntraScope({ id: "hr", url, entraScope: HR }, undefined, undefined),
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
        BINDING,
      ),
    ).toEqual({
      refusal:
        "以登录人的身份访问的服务器使用本人的 Microsoft 登录，不收令牌。",
    });
    expect(
      decideEntraScope(
        { id: "hr", url, credentialId: "cred" },
        { url, entraScope: HR },
        BINDING,
      ),
    ).toEqual({
      refusal:
        "hr 以登录人的身份访问，不收令牌。要改用令牌访问，请同时把 entraScope 设为 null。",
    });
  });

  test("more than one scope, or one too long to be a scope, is refused", () => {
    for (const entraScope of [`${HR} api://payroll/.default`, "a".repeat(257)])
      expect(
        decideEntraScope({ id: "hr", url, entraScope }, undefined, BINDING),
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
    // Marking one that was not marked while moving it says so, rather than that it was marked.
    const markingWhileMoving = {
      refusal:
        "hr 已经在另一个地址。换地址时不能同时设为以登录人的身份访问，请先移除再重新添加。",
    };
    expect(
      decideEntraScope(
        { id: "hr", url: moved },
        { url, entraScope: HR },
        BINDING,
      ),
    ).toEqual(refusal);
    expect(
      decideEntraScope(
        { id: "hr", url: moved, entraScope: null },
        { url, entraScope: HR },
        BINDING,
      ),
    ).toEqual(refusal);
    expect(
      decideEntraScope(
        { id: "hr", url: moved, entraScope: HR },
        { url, entraScope: null },
        BINDING,
      ),
    ).toEqual(markingWhileMoving);
    // An unmarked server moving is the deployment-token rule's business, not this one's.
    expect(
      read(
        decideEntraScope(
          { id: "hr", url: moved },
          { url, entraScope: null },
          BINDING,
        ),
      ),
    ).toEqual({ named: "not named", scope: "no scope" });
  });
});

describe("entraTokenFor", () => {
  const row = { title: "HR", url: HR_URL, entraScope: HR };

  test("hands back the token Entra issued for the person and this scope", async () => {
    const asked: [string, string][] = [];
    const token = await entraTokenFor(
      {
        ...BINDING,
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
      ...BINDING,
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
            ...BINDING,
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
          ...BINDING,
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

describe("which resources a scope may name, and where its token may go (review I-2)", () => {
  test("the resource is the scope less its permission, and a bare permission names none", () => {
    expect(scopeResource("api://hr-api/.default")).toBe("api://hr-api");
    expect(scopeResource("API://HR-API/read")).toBe("api://hr-api");
    expect(scopeResource("https://contoso.com/hr/.default")).toBe(
      "https://contoso.com/hr",
    );
    expect(scopeResource(`${OPENBOT}/.default`)).toBe(OPENBOT);
    // What Entra reads as Microsoft Graph, and shapes with no permission at all.
    for (const named of ["User.Read", "api://hr-api", "api://hr-api/"])
      expect(scopeResource(named)).toBeNull();
  });

  test("OpenBot's own API, by any of its names or under it, is never a resource", () => {
    for (const resource of [
      OPENBOT,
      `api://${OPENBOT}`,
      `API://${OPENBOT.toUpperCase()}`,
      `api://${OPENBOT}/admin`,
    ])
      expect(forbiddenResource(resource, BINDING.own)).toBe("own");
    // A custom API scope's resource is OpenBot's too.
    expect(
      forbiddenResource(
        "api://openbot.example.com",
        openBotResources(OPENBOT, "api://openbot.example.com/access_as_user"),
      ),
    ).toBe("own");
  });

  test("Microsoft's first-party resources are never a resource", () => {
    for (const resource of [
      "https://graph.microsoft.com",
      "00000003-0000-0000-c000-000000000000",
      "00000003-0000-0ff1-ce00-000000000000",
      "https://contoso.sharepoint.com",
      "https://outlook.office365.com",
      "https://management.azure.com",
      "https://vault.azure.net",
      "797f4846-ba00-4fd7-ba43-dac1f8f63013",
    ])
      expect(forbiddenResource(resource, BINDING.own)).toBe("microsoft");
    expect(forbiddenResource("api://hr-api", BINDING.own)).toBeNull();
    expect(
      forbiddenResource("https://hr.contoso.com/api", BINDING.own),
    ).toBeNull();
  });

  test("a deployment registers each resource with the one host its tokens go to", () => {
    expect(
      parseOboResources(
        [
          "API://HR-API=HR.example.com",
          "https://contoso.com/pay/=pay.contoso.com",
        ],
        BINDING.own,
      ),
    ).toEqual([
      { resource: "api://hr-api", host: "hr.example.com" },
      { resource: "https://contoso.com/pay", host: "pay.contoso.com" },
    ]);
    expect(() => parseOboResources(["api://hr-api"], BINDING.own)).toThrow(
      "MICROSOFT_OAUTH_OBO_RESOURCES 的「api://hr-api」写法不对。",
    );
    expect(() =>
      parseOboResources(["api://hr-api=https://hr.example.com"], BINDING.own),
    ).toThrow("写法不对");
    expect(() =>
      parseOboResources([`api://${OPENBOT}=hr.example.com`], BINDING.own),
    ).toThrow("登记了 OpenBot 自己的 API");
    expect(() =>
      parseOboResources(
        ["https://graph.microsoft.com=hr.example.com"],
        BINDING.own,
      ),
    ).toThrow("登记了 Microsoft 的第一方资源");
  });

  test("a scope is refused unless it names a registered resource and the server is at its host", () => {
    expect(scopeBindingRefusal(HR, HR_URL, BINDING)).toBeNull();
    expect(scopeBindingRefusal("User.Read", HR_URL, BINDING)).toContain(
      "没有写明资源",
    );
    expect(
      scopeBindingRefusal(`api://${OPENBOT}/.default`, HR_URL, BINDING),
    ).toBe(
      "不能用 OpenBot 自己的 API 作为 Entra scope：换出来的 token 能冒充本人调用 OpenBot。",
    );
    expect(
      scopeBindingRefusal(
        "https://graph.microsoft.com/.default",
        HR_URL,
        BINDING,
      ),
    ).toBe(
      "不能用 Microsoft 的第一方资源（例如 Microsoft Graph）作为 Entra scope：这类 token 权限太大，不能发给自定义服务器。",
    );
    expect(scopeBindingRefusal("api://payroll/.default", HR_URL, BINDING)).toBe(
      "api://payroll 没有登记在部署设置 MICROSOFT_OAUTH_OBO_RESOURCES 里。请运维把它和它的服务器主机一起登记（<资源>=<主机>）。",
    );
    expect(
      scopeBindingRefusal(HR, "https://attacker.example/mcp", BINDING),
    ).toBe(
      "api://hr-api 登记的服务器主机是 hr.example.com，和这个服务器的地址（attacker.example）不一致。token 只发往登记的主机。",
    );
    // A subdomain is another host.
    expect(
      scopeBindingRefusal(HR, "https://evil.hr.example.com/mcp", BINDING),
    ).not.toBeNull();
    // Nothing registered, nothing marked.
    expect(
      scopeBindingRefusal(HR, HR_URL, { resources: [], own: BINDING.own }),
    ).not.toBeNull();
  });

  test("marking is refused on the same grounds, before anything is written", () => {
    expect(
      decideEntraScope(
        {
          id: "x",
          url: "https://attacker.example/mcp",
          entraScope: "https://graph.microsoft.com/.default",
        },
        undefined,
        BINDING,
      ),
    ).toEqual({
      refusal:
        "不能用 Microsoft 的第一方资源（例如 Microsoft Graph）作为 Entra scope：这类 token 权限太大，不能发给自定义服务器。",
    });
    expect(
      decideEntraScope(
        { id: "x", url: "https://attacker.example/mcp", entraScope: HR },
        undefined,
        BINDING,
      ),
    ).toHaveProperty("refusal");
  });

  test("a call is not made when the scope is no longer registered for the server's host", async () => {
    let asked = 0;
    const tokenFor = async () => {
      asked += 1;
      return "obo-token";
    };
    const sentence =
      "「HR」的 Entra scope 已经不在部署登记的范围里，所以没有发出。请联系管理员。";
    // Registered for another host since; registered nowhere; a caller that passed no resources.
    for (const tokens of [
      {
        ...BINDING,
        resources: [{ resource: "api://hr-api", host: "hr2.example.com" }],
        tokenFor,
      },
      { ...BINDING, resources: [], tokenFor },
      { tokenFor },
    ])
      await expect(
        entraTokenFor(
          tokens,
          { title: "HR", url: HR_URL, entraScope: HR },
          "user-1",
          refuse,
        ),
      ).rejects.toThrow(sentence);
    expect(asked).toBe(0);
  });
});

describe("hardening after re-review", () => {
  test("a scope is only ever sent over https (N-2)", () => {
    const sentence =
      "以登录人的身份访问的服务器必须用 https 地址，否则本人的 token 会被明文发出。请把地址改成 https 后重新添加。";
    for (const url of [
      "http://hr.example.com/mcp",
      "ws://hr.example.com/mcp",
      "not a url",
    ])
      expect(scopeBindingRefusal(HR, url, BINDING)).toBe(sentence);
    expect(
      decideEntraScope(
        { id: "hr", url: "http://hr.example.com/mcp", entraScope: HR },
        undefined,
        BINDING,
      ),
    ).toEqual({ refusal: sentence });
  });

  test("a call to a marked server at plain http is not made", async () => {
    let asked = 0;
    await expect(
      entraTokenFor(
        {
          ...BINDING,
          tokenFor: async () => {
            asked += 1;
            return "obo-token";
          },
        },
        { title: "HR", url: "http://hr.example.com/mcp", entraScope: HR },
        "user-1",
        refuse,
      ),
    ).rejects.toThrow(
      "「HR」的 Entra scope 已经不在部署登记的范围里，所以没有发出。请联系管理员。",
    );
    expect(asked).toBe(0);
  });

  test("a resource registered twice is refused, whatever the case or trailing slash (N-3)", () => {
    for (const entries of [
      ["api://hr-api=hr.example.com", "api://hr-api=attacker.example"],
      ["api://hr-api=hr.example.com", "API://HR-API/=hr.example.com"],
    ])
      expect(() => parseOboResources(entries, BINDING.own)).toThrow(
        "MICROSOFT_OAUTH_OBO_RESOURCES 里 api://hr-api 写了不止一次。一个资源只能登记一个主机，请只留一项。",
      );
  });
});
