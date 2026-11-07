import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import {
  AvatarSourcesPanel,
  SourcesStep,
} from "@/components/avatar/avatar-sources";
import type { AvatarConnectorOption, AvatarSource } from "@/lib/avatar/sources";
import type { KnowledgeNotebook } from "@/lib/knowledge/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Story F1, stage 3: one of the person's own 知识库 notebooks (S3) or one of their own connected
 * accounts (S4) as their 分身's information source.
 *
 * The 知识库 option lists the person's notebooks and saves the one picked by its id; the 连接器 option
 * lists the person's own connected accounts as the server reports them, and one the server says
 * cannot be given (not listed by the administrator) shows why and cannot be picked. Each says what
 * reaches the model and needs its own tick (D6), and with nothing to pick, says where to make or
 * connect one. Both places: the 分身's detail panel and the onboarding step. The fetch is faked and
 * records every call.
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string; body: unknown }[] = [];
const writes = () => calls.filter((call) => call.method !== "GET");

const AVATAR = "avatar-person-1";
const MEETINGS = "11111111-1111-4111-8111-111111111111";
const DIARY = "22222222-2222-4222-8222-222222222222";

const notebooksOf = (...titles: Array<[string, string]>): KnowledgeNotebook[] =>
  titles.map(([id, title]) => ({
    id,
    title,
    revision: 1,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  }));

const drive: AvatarConnectorOption = {
  serverId: "google-drive",
  title: "Google Drive",
  attached: false,
  attachable: true,
  reason: null,
};
const wiki: AvatarConnectorOption = {
  serverId: "team-wiki",
  title: "团队百科",
  attached: false,
  attachable: false,
  reason: "管理员还没有把这个连接器上架给个人使用，暂时不能交给分身。",
};

/** The sources endpoint as the server keeps it, the person's notebooks and their connections. */
function serve(options: {
  sources?: AvatarSource[];
  notebooks: KnowledgeNotebook[];
  connectors: AvatarConnectorOption[];
}) {
  let sources = [...(options.sources ?? [])];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (path === "/api/knowledge/notebooks")
      return Response.json({ notebooks: options.notebooks });
    if (path === "/api/me/avatar/sources/connectors")
      return Response.json({
        connectors: options.connectors.map((connector) => ({
          ...connector,
          attached: sources.some(
            (source) =>
              source.kind === "connector" &&
              source.serverId === connector.serverId,
          ),
          attachable:
            connector.attachable &&
            !sources.some(
              (source) =>
                source.kind === "connector" &&
                source.serverId === connector.serverId,
            ),
        })),
      });
    if (path === "/api/me/avatar/sources" && method === "GET")
      return Response.json({
        agentId: AVATAR,
        configuredAt: sources.length ? "2026-11-04T00:00:00.000Z" : null,
        sources,
      });
    if (path === "/api/me/avatar/sources" && method === "POST") {
      const id = `33333333-3333-4333-8333-33333333333${sources.length}`;
      const createdAt = "2026-11-04T01:00:00.000Z";
      let source: AvatarSource;
      if (body.kind === "notebook") {
        const title =
          options.notebooks.find((entry) => entry.id === body.notebookId)
            ?.title ?? "";
        source = {
          id,
          kind: "notebook",
          label: body.label || title,
          note: body.note,
          notebookId: body.notebookId,
          title,
          createdAt,
        };
      } else if (body.kind === "connector") {
        const title =
          options.connectors.find((entry) => entry.serverId === body.serverId)
            ?.title ?? "";
        source = {
          id,
          kind: "connector",
          label: body.label || title,
          note: body.note,
          serverId: body.serverId,
          title,
          createdAt,
        };
      } else {
        source = {
          id,
          kind: "declaration",
          label: body.label,
          note: body.note,
          createdAt,
        };
      }
      sources = [...sources, source];
      return Response.json({ source }, { status: 201 });
    }
    if (path.startsWith("/api/me/avatar/sources/") && method === "DELETE") {
      const removed = decodeURIComponent(path.split("/").at(-1) ?? "");
      sources = sources.filter((source) => source.id !== removed);
      return Response.json({ removed: true });
    }
    if (path === "/api/me/onboarding")
      return Response.json({
        onboarding: { step: body.step, completedAt: null },
      });
    return Response.json({ error: "not faked" }, { status: 404 });
  }) as typeof fetch;
}

function draw(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

const button = (view: ReturnType<typeof render>, name: string) =>
  view.getByRole("button", { name }) as HTMLButtonElement;
const NOTEBOOK_CONSENT = "我已了解，分身搜索到的知识库内容会发送给模型服务";
const CONNECTOR_CONSENT = "我已了解，分身通过连接器读到的内容会发送给模型服务";

test("the detail panel lists the person's own notebooks, saves the one picked by id after the tick, and removes it", async () => {
  serve({
    notebooks: notebooksOf([MEETINGS, "客户纪要"], [DIARY, "私人日记"]),
    connectors: [drive],
  });
  const { view, user } = draw(<AvatarSourcesPanel />);
  await view.findByText("还没有登记信息来源。");

  await user.click(button(view, "知识库"));
  const picker = within(
    (await view.findByText("选择一个你的知识库")).closest(
      "fieldset",
    ) as HTMLElement,
  );
  expect(picker.getByLabelText(/客户纪要/)).toBeTruthy();
  expect(picker.getByLabelText(/私人日记/)).toBeTruthy();
  // What reaches the model is said before anything can be saved (D6).
  expect(view.getByText(/搜到的片段会发送给你所用的模型服务/)).toBeTruthy();

  await user.click(picker.getByLabelText(/客户纪要/));
  const add = button(view, "添加信息来源");
  expect(add.disabled).toBeTrue();
  await user.click(view.getByRole("checkbox", { name: NOTEBOOK_CONSENT }));
  await user.type(view.getByLabelText("说明（可选）"), "每次拜访后更新");
  await user.click(add);

  const saved = within(
    await view.findByRole("list", { name: "已登记的信息来源" }),
  );
  expect(await saved.findByText("知识库 · 客户纪要")).toBeTruthy();
  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/api/me/avatar/sources",
      body: {
        kind: "notebook",
        notebookId: MEETINGS,
        label: "",
        note: "每次拜访后更新",
      },
    },
  ]);
  // Added once is added: the same notebook cannot be picked again.
  await waitFor(() =>
    expect(
      (picker.getByLabelText(/客户纪要/) as HTMLInputElement).disabled,
    ).toBeTrue(),
  );
  expect(picker.getByText(/已添加/)).toBeTruthy();
  expect(
    (picker.getByLabelText(/私人日记/) as HTMLInputElement).disabled,
  ).toBeFalse();

  await user.click(button(view, "删除 客户纪要"));
  expect(await view.findByText("还没有登记信息来源。")).toBeTruthy();
  expect(writes().at(-1)).toEqual({
    method: "DELETE",
    path: "/api/me/avatar/sources/33333333-3333-4333-8333-333333333330",
    body: null,
  });
});

test("the connector option lists the person's own connections; one not listed shows why and cannot be picked", async () => {
  serve({ notebooks: [], connectors: [drive, wiki] });
  const { view, user } = draw(<AvatarSourcesPanel />);
  await view.findByText("还没有登记信息来源。");

  await user.click(button(view, "连接器"));
  const picker = within(
    (await view.findByText("选择一个你已连接的账号")).closest(
      "fieldset",
    ) as HTMLElement,
  );
  const blocked = picker.getByLabelText(/团队百科/) as HTMLInputElement;
  expect(blocked.disabled).toBeTrue();
  expect(picker.getByText(wiki.reason ?? "")).toBeTruthy();
  // The approvals still apply, and that is said before the tick.
  expect(view.getByText(/每次调用都受你的审批规则约束/)).toBeTruthy();

  await user.click(picker.getByLabelText(/Google Drive/));
  expect(button(view, "添加信息来源").disabled).toBeTrue();
  await user.click(view.getByRole("checkbox", { name: CONNECTOR_CONSENT }));
  await user.click(button(view, "添加信息来源"));

  const saved = within(
    await view.findByRole("list", { name: "已登记的信息来源" }),
  );
  expect(await saved.findByText("连接器 · Google Drive")).toBeTruthy();
  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/api/me/avatar/sources",
      body: {
        kind: "connector",
        serverId: "google-drive",
        label: "",
        note: "",
      },
    },
  ]);
  // The server now says it is attached, and the picker follows.
  await waitFor(() =>
    expect(
      (picker.getByLabelText(/Google Drive/) as HTMLInputElement).disabled,
    ).toBeTrue(),
  );
});

test("with no notebook or no connected account the panel says where to make or connect one, with links", async () => {
  serve({ notebooks: [], connectors: [] });
  const { view, user } = draw(<AvatarSourcesPanel />);
  await view.findByText("还没有登记信息来源。");

  await user.click(button(view, "知识库"));
  expect(await view.findByText("还没有知识库")).toBeTruthy();
  expect(
    view.getByRole("link", { name: "前往「知识库」新建" }).getAttribute("href"),
  ).toBe("/resources?tab=knowledge");

  await user.click(button(view, "连接器"));
  expect(await view.findByText("还没有已连接的账号")).toBeTruthy();
  expect(
    view
      .getByRole("link", { name: "前往「已连接的账号」" })
      .getAttribute("href"),
  ).toBe("/settings/connected-accounts");
  expect(writes()).toEqual([]);
});

test("the limit counts every kind: at ten sources nothing more can be added", async () => {
  serve({
    notebooks: notebooksOf([MEETINGS, "客户纪要"]),
    connectors: [drive],
    sources: Array.from({ length: 10 }, (_, index) => ({
      id: `44444444-4444-4444-8444-4444444444${String(index).padStart(2, "0")}`,
      kind: "declaration" as const,
      label: `声明 ${index + 1}`,
      note: "",
      createdAt: "2026-11-04T00:00:00.000Z",
    })),
  });
  const { view } = draw(<AvatarSourcesPanel />);
  expect(
    await view.findByText("已经登记了 10 个信息来源，这是上限。"),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "知识库" })).toBeNull();
  expect(view.queryByRole("button", { name: "连接器" })).toBeNull();
});

test("in onboarding a notebook can be picked and saved before moving on; with no account the step names the place and can be skipped", async () => {
  serve({ notebooks: notebooksOf([MEETINGS, "客户纪要"]), connectors: [] });
  let advanced = 0;
  const first = draw(
    <SourcesStep nextStep={2} onAdvanced={() => (advanced += 1)} />,
  );
  await first.view.findByText("还没有登记信息来源。");
  await first.user.click(button(first.view, "知识库"));
  await first.user.click(await first.view.findByLabelText(/客户纪要/));
  expect(button(first.view, "保存并继续").disabled).toBeTrue();
  await first.user.click(
    first.view.getByRole("checkbox", { name: NOTEBOOK_CONSENT }),
  );
  await first.user.click(button(first.view, "保存并继续"));
  await waitFor(() => expect(advanced).toBe(1));
  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/api/me/avatar/sources",
      body: { kind: "notebook", notebookId: MEETINGS, label: "", note: "" },
    },
    { method: "POST", path: "/api/me/onboarding", body: { step: 2 } },
  ]);
  cleanup();
  calls.length = 0;

  serve({ notebooks: [], connectors: [] });
  const second = draw(
    <SourcesStep nextStep={2} onAdvanced={() => (advanced += 1)} />,
  );
  await second.view.findByText("还没有登记信息来源。");
  await second.user.click(button(second.view, "连接器"));
  expect(await second.view.findByText("还没有已连接的账号")).toBeTruthy();
  // The rest of the app opens after onboarding, so the step names the place rather than linking.
  expect(second.view.getByText(/「设置 ›\s*已连接的账号」/)).toBeTruthy();
  expect(second.view.queryByRole("link")).toBeNull();
  await second.user.click(button(second.view, "跳过，稍后在分身详情页配置"));
  await waitFor(() => expect(advanced).toBe(2));
  expect(writes()).toEqual([
    { method: "POST", path: "/api/me/onboarding", body: { step: 2 } },
  ]);
});
