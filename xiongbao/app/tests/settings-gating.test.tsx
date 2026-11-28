import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { SettingsSection } from "@/components/settings/settings-section";
import {
  type SectionAudience,
  useSettingsAudience,
} from "@/lib/settings/audience";
import { queryClient } from "@/query-client";
import {
  type AudienceName,
  OfflineWebSocket,
  renderAt,
  stubFetchFor,
} from "./settings-audience-kit";
import { settleReactWork } from "./settle-react-work";

/*
 * 节组件本身的门控（spec §10.2）。页面级的「每种受众每页有哪些节」随各话题页一起加。
 */

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

const ADMIN_NOTE = "只有管理员看得到。改动对所有成员生效。";

function Ready() {
  return useSettingsAudience().ready ? <i data-testid="ready" /> : null;
}

/** 一节受众受限的、一节人人可见的，外加「受众读完」的标记。 */
function Page({ audience }: { audience: SectionAudience }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Ready />
      <SettingsSection id="open" title="人人可见">
        <p>开放内容</p>
      </SettingsSection>
      <SettingsSection
        audience={audience}
        description="说明文字"
        id="gated"
        title="受限的节"
      >
        <p>受限内容</p>
      </SettingsSection>
    </QueryClientProvider>
  );
}

async function readyView(audienceName: AudienceName, section: SectionAudience) {
  stubFetchFor(audienceName);
  const view = render(<Page audience={section} />);
  // 读失败的受众（unknown-edition）要等查询重试用完才算读完。
  await waitFor(() => expect(view.queryByTestId("ready")).not.toBeNull(), {
    timeout: 20000,
  });
  return view;
}

const TEAM_ADMIN: SectionAudience = { who: "team-admin", edition: "both" };

describe("受众不满足时不画", () => {
  test("成员看不到 team-admin 的节，人人可见的节还在", async () => {
    const view = await readyView("team-member", TEAM_ADMIN);
    expect(view.queryByText("受限内容")).toBeNull();
    expect(view.queryByText("受限的节")).toBeNull();
    expect(view.queryByText("开放内容")).not.toBeNull();
  });

  test("管理员看得到", async () => {
    const view = await readyView("team-admin", TEAM_ADMIN);
    expect(view.queryByText("受限内容")).not.toBeNull();
  });

  test("个人版看不到 team-admin 的节（即便是同一个管理员账号）", async () => {
    const view = await readyView("personal", TEAM_ADMIN);
    expect(view.queryByText("受限内容")).toBeNull();
  });

  test("edition 限定：team 的节个人版不画，personal 的节团队版不画", async () => {
    const team = await readyView("team-member", {
      who: "everyone",
      edition: "team",
    });
    expect(team.queryByText("受限内容")).not.toBeNull();
    cleanup();
    queryClient.clear();
    const personal = await readyView("personal", {
      who: "everyone",
      edition: "team",
    });
    expect(personal.queryByText("受限内容")).toBeNull();
    cleanup();
    queryClient.clear();
    const personalOnly = await readyView("personal", {
      who: "everyone",
      edition: "personal",
    });
    expect(personalOnly.queryByText("受限内容")).not.toBeNull();
  });

  test("读不到版本按团队版：管理员仍看得到 team-admin 的节", async () => {
    const view = await readyView("unknown-edition", TEAM_ADMIN);
    expect(view.queryByText("受限内容")).not.toBeNull();
  }, 30000);
});

test("ready 之前受众受限的节不出现，人人可见的节照常画", async () => {
  // 读取一直挂着：受众永远不 ready。
  globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), {
    preconnect: originalFetch.preconnect,
  });
  const view = render(<Page audience={TEAM_ADMIN} />);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(view.queryByTestId("ready")).toBeNull();
  expect(view.queryByText("受限的节")).toBeNull();
  expect(view.queryByText("受限内容")).toBeNull();
  expect(view.queryByText("开放内容")).not.toBeNull();
});

describe("team-admin 的节描述", () => {
  test("描述前固定加「只有管理员看得到。改动对所有成员生效。」", async () => {
    const view = await readyView("team-admin", TEAM_ADMIN);
    const section = view.container.querySelector("section#gated");
    expect(section?.querySelector("p")?.textContent).toBe(
      `${ADMIN_NOTE}说明文字`,
    );
  });

  test("没有描述时只有这一句；人人可见的节不加", async () => {
    stubFetchFor("team-admin");
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Ready />
        <SettingsSection audience={TEAM_ADMIN} id="bare" title="无描述">
          <p>内容</p>
        </SettingsSection>
        <SettingsSection id="plain" description="普通说明" title="普通">
          <p>内容</p>
        </SettingsSection>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(view.queryByTestId("ready")).not.toBeNull());
    expect(view.container.querySelector("#bare p")?.textContent).toBe(
      ADMIN_NOTE,
    );
    expect(view.container.querySelector("#plain p")?.textContent).toBe(
      "普通说明",
    );
  });
});

test("id 落在节自己的 <section> 上，标题和内容都在它里面", async () => {
  const view = await readyView("team-admin", TEAM_ADMIN);
  const section = view.container.querySelector("section#gated");
  expect(section).not.toBeNull();
  expect(section?.querySelector("h2")?.textContent).toBe("受限的节");
  expect(section?.textContent).toContain("受限内容");
  expect(view.container.querySelectorAll("#gated")).toHaveLength(1);
});

describe("renderAt 夹具", () => {
  test("team-admin 经真实路由树：/plans 落到 /settings/plans", async () => {
    const { finalHref } = await renderAt("/plans", "team-admin");
    expect(finalHref()).toBe("/settings/plans");
  }, 60000);

  test("角色是读出来的：管理员留在 /admin，成员被送回首页", async () => {
    const admin = await renderAt("/admin/proactive", "team-admin");
    expect(admin.finalHref()).toBe("/admin/proactive");
    cleanup();
    queryClient.clear();
    const member = await renderAt("/admin/proactive", "team-member");
    expect(member.finalHref()).toBe("/");
  }, 60000);
});
