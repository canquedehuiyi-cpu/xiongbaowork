import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type MutationFunctionContext,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DeploymentClientsSection,
  deploymentClientProblem,
} from "@/components/plugins/deployment-clients";
import {
  brokeredConnectionFieldsMutationOptions,
  saveDeploymentClientMutationOptions,
} from "@/lib/plugins/mutations";
import { deploymentClientsQueryOptions } from "@/lib/plugins/queries";
import { queryClient as appQueryClient } from "@/query-client";

/**
 * 插件会话合入的服务端接口在浏览器这一侧的接法：连接表单第一下要密钥指引（上游 #1297），以及管理员
 * 保存、查看、删除部署专属客户端（上游 #950）。
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  appQueryClient.clear();
});

type Asked = { url: string; method: string; body: unknown };

function stub(answer: (asked: Asked) => Response): Asked[] {
  const asked: Asked[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = {
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    asked.push(request);
    return answer(request);
  }) as unknown as typeof fetch;
  return asked;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function context(): MutationFunctionContext {
  return { client: new QueryClient(), meta: undefined };
}

describe("连接表单的第一下（上游 #1297）", () => {
  test("带 { guide: true } 去问，拿回表单和中文指引", async () => {
    const asked = stub(() =>
      json({
        fields: [
          {
            name: "generic_api_key",
            label: "API 密钥",
            help: "",
            required: true,
            secret: true,
          },
        ],
        guide: { steps: "登录后台，新建一个密钥。", url: null },
      }),
    );
    const answer = await brokeredConnectionFieldsMutationOptions().mutationFn?.(
      "gmail",
      context(),
    );
    expect(asked[0]?.method).toBe("POST");
    expect(asked[0]?.body).toEqual({ guide: true });
    expect(answer?.fields.map((field) => field.name)).toEqual([
      "generic_api_key",
    ]);
    expect(answer?.guide).toEqual({
      steps: "登录后台，新建一个密钥。",
      url: null,
    });
  });

  test("服务端没给指引时照样画表单，指引为空", async () => {
    stub(() => json({ fields: [] }));
    const answer = await brokeredConnectionFieldsMutationOptions().mutationFn?.(
      "gmail",
      context(),
    );
    expect(answer).toEqual({ fields: [], guide: null });
  });

  test("回的是授权链接而不是表单时，答案是 null，不是空表单", async () => {
    stub(() => json({ authorizationUrl: "https://example.invalid/consent" }));
    const answer = await brokeredConnectionFieldsMutationOptions().mutationFn?.(
      "gmail",
      context(),
    );
    expect(answer).toBeNull();
  });
});

describe("部署专属客户端（上游 #950）", () => {
  test("读列表时解开 clients 信封", async () => {
    stub(() =>
      json({
        clients: [
          {
            toolkit: "shopify",
            clientId: "abc",
            storedAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const clients = await new QueryClient().fetchQuery(
      deploymentClientsQueryOptions(),
    );
    expect(clients).toEqual([
      {
        toolkit: "shopify",
        clientId: "abc",
        storedAt: "2026-11-01T00:00:00.000Z",
      },
    ]);
  });

  test("保存时以 PUT 发 client_id 和 client_secret，发完把密钥从变量里抹掉", async () => {
    const asked = stub(() =>
      json({ toolkit: "shopify", clientId: "abc", replaced: false }),
    );
    const variables = {
      toolkit: "shopify",
      clientId: "abc",
      clientSecret: "shh",
    };
    const saved = await saveDeploymentClientMutationOptions(
      new QueryClient(),
    ).mutationFn?.(variables, context());
    expect(asked[0]).toEqual({
      url: "/api/plugins/composio/clients/shopify",
      method: "PUT",
      body: { client_id: "abc", client_secret: "shh" },
    });
    expect(saved).toEqual({
      toolkit: "shopify",
      clientId: "abc",
      replaced: false,
    });
    expect(variables.clientSecret).toBe("");
  });

  test("按服务端的规则先挡住明显不对的输入", () => {
    expect(
      deploymentClientProblem({
        toolkit: "Shop ify",
        clientId: "a",
        clientSecret: "b",
      }),
    ).toBe("应用名只能包含字母、数字、下划线和连字符，最长 64 个字符。");
    expect(
      deploymentClientProblem({
        toolkit: "shopify",
        clientId: "a",
        clientSecret: " ",
      }),
    ).toBe("客户端 ID 和客户端密钥都要填写。");
    expect(
      deploymentClientProblem({
        toolkit: "shopify",
        clientId: "x".repeat(513),
        clientSecret: "b",
      }),
    ).toBe("客户端 ID 不能超过 512 个字符。");
    expect(
      deploymentClientProblem({
        toolkit: "Shopify",
        clientId: "a",
        clientSecret: "b",
      }),
    ).toBeNull();
  });

  function renderSection() {
    return render(
      <QueryClientProvider client={appQueryClient}>
        <DeploymentClientsSection />
      </QueryClientProvider>,
    );
  }

  test("列出客户端 ID 和保存日期，从不显示密钥；说明以管理员身份调用", async () => {
    stub(() =>
      json({
        clients: [
          {
            toolkit: "shopify",
            clientId: "abc",
            storedAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const view = renderSection();
    const row = await view.findByTestId("deployment-client-shopify");
    expect(within(row).getByText(/客户端 ID：abc/)).toBeTruthy();
    expect(view.getByText(/员工通过它调用时以管理员身份/)).toBeTruthy();
  });

  test("保存：密钥框是密码框，保存后关掉窗口，提示可以去目录添加", async () => {
    let clients: unknown[] = [];
    const asked = stub((request) => {
      if (request.method === "PUT") {
        clients = [{ toolkit: "shopify", clientId: "abc", storedAt: null }];
        return json({ toolkit: "shopify", clientId: "abc", replaced: false });
      }
      return json({ clients });
    });
    const view = renderSection();
    await view.findByText("还没有保存任何客户端。");

    await userEvent.click(view.getByRole("button", { name: "保存客户端" }));
    await userEvent.type(await view.findByLabelText("应用名"), "shopify");
    await userEvent.type(view.getByLabelText("客户端 ID"), "abc");
    const secret = view.getByLabelText("客户端密钥");
    expect(secret.getAttribute("type")).toBe("password");
    await userEvent.type(secret, "shh");
    await userEvent.click(view.getByRole("button", { name: "保存" }));

    expect(
      await view.findByText(
        /已保存 shopify 的客户端。现在可以在应用目录里添加它了。/,
      ),
    ).toBeTruthy();
    expect(asked.find((request) => request.method === "PUT")?.body).toEqual({
      client_id: "abc",
      client_secret: "shh",
    });
    await waitFor(() => expect(view.queryByLabelText("客户端密钥")).toBeNull());
    expect(await view.findByTestId("deployment-client-shopify")).toBeTruthy();
    expect(view.queryByText("shh")).toBeNull();
  });

  test("保存被拒时，窗口里显示服务端的中文原因", async () => {
    stub((request) =>
      request.method === "PUT"
        ? json(
            {
              error:
                "客户端 ID 和客户端密钥都要填写，ID 不超过 512 个字符、密钥不超过 4096 个字符，且不能包含控制字符。",
            },
            400,
          )
        : json({ clients: [] }),
    );
    const view = renderSection();
    await view.findByText("还没有保存任何客户端。");
    await userEvent.click(view.getByRole("button", { name: "保存客户端" }));
    await userEvent.type(await view.findByLabelText("应用名"), "shopify");
    await userEvent.type(view.getByLabelText("客户端 ID"), "abc");
    await userEvent.type(view.getByLabelText("客户端密钥"), "shh");
    await userEvent.click(view.getByRole("button", { name: "保存" }));
    expect(await view.findByText(/且不能包含控制字符/)).toBeTruthy();
  });

  test("删除一个仍被已启用应用使用的客户端时，显示服务端的提醒", async () => {
    stub((request) =>
      request.method === "DELETE"
        ? json({
            removed: true,
            stillInUseByEnabledApp: true,
            note: "删除只影响以后的启用：已经启用的 shopify 仍在用这个客户端。",
          })
        : json({
            clients: [{ toolkit: "shopify", clientId: "abc", storedAt: null }],
          }),
    );
    const view = renderSection();
    const row = await view.findByTestId("deployment-client-shopify");
    await userEvent.click(within(row).getByRole("button", { name: "删除" }));
    expect(
      await view.findByText(/已经启用的 shopify 仍在用这个客户端/),
    ).toBeTruthy();
  });
});
