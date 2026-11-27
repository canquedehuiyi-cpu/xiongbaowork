import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { LICENCE_HOLDER } from "@xiongbao/shared/licence-paragraph";
import { SETTINGS_SIDEBAR_ITEMS } from "@/components/settings/settings-sidebar";
import { appConfig } from "@/lib/generated/application-config";
import { AboutPage, ThirdPartyNotices } from "@/routes/_authed/settings/about";
import { settleReactWork } from "./settle-react-work";

/*
 * 关于页：产品名、版本、公司名，以及第三方依赖清单（清单里有一行产品最初所基于代码的 MIT 许可）。真实清单有 1.8 MB，
 * 这里换成小夹具，既快也不依赖生成步骤的输出。
 */
mock.module("@/lib/generated/third-party-notices.json", () => ({
  default: [
    {
      name: "left-pad",
      version: "1.3.0",
      license: "WTFPL",
      licenseText: "Do what the fuck you want to public license text",
    },
    { name: "no-text-pkg", version: "2.0.0", license: "ISC" },
  ],
}));

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(cleanup);

const holder = new RegExp(LICENCE_HOLDER);

function open() {
  const router = createRouter({
    routeTree: createRootRoute({ component: AboutPage }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router as never} />);
}

test("关于页写明公司名，不带上游仓库链接，也没有单独的基础代码标题", async () => {
  const view = open();
  await view.findByText("left-pad");
  expect(view.container.textContent).toContain(
    `© 2026 ${appConfig.brand.companyName}`,
  );
  expect(view.container.textContent).toContain(appConfig.brand.productName);
  expect(view.container.textContent).not.toContain("基础代码");
  expect(view.container.innerHTML).not.toContain("github.com/");
});

test("依赖清单里有基础代码的 MIT 许可一行（版本写「—」、许可 MIT），按权利人名搜索能找到，展开后是版权行与 MIT 全文", async () => {
  const view = open();
  const row = await view.findByRole("button", { name: holder });
  expect(row.textContent).toContain("—");
  expect(row.textContent).toContain("MIT");
  expect(view.container.textContent).not.toContain(
    "Permission is hereby granted",
  );

  fireEvent.change(view.getByRole("searchbox"), {
    target: { value: LICENCE_HOLDER.slice(0, 7).toLowerCase() },
  });
  expect(view.queryByText("left-pad")).toBeNull();

  fireEvent.click(view.getByRole("button", { name: holder }));
  expect(view.container.textContent).toContain(
    `Copyright (c) 2026 ${LICENCE_HOLDER}`,
  );
  expect(view.container.textContent).toContain("Permission is hereby granted");
  expect(view.container.textContent).toContain("THE SOFTWARE IS PROVIDED");
});

test("第三方依赖列出名称、版本、许可类型，点开才看到全文，搜索按名称过滤", async () => {
  const view = open();
  expect(await view.findByText("left-pad")).not.toBeNull();
  expect(view.getByText("1.3.0")).not.toBeNull();
  expect(view.getByText("WTFPL")).not.toBeNull();
  expect(view.container.textContent).not.toContain("Do what the fuck");

  fireEvent.click(view.getByRole("button", { name: /left-pad/ }));
  expect(view.container.textContent).toContain("Do what the fuck");

  fireEvent.click(view.getByRole("button", { name: /no-text-pkg/ }));
  expect(view.container.textContent).toContain("未附许可全文");

  fireEvent.change(view.getByRole("searchbox"), {
    target: { value: "no-text" },
  });
  expect(view.queryByText("left-pad")).toBeNull();
  expect(view.getByText("no-text-pkg")).not.toBeNull();
});

test("依赖清单加载失败时，随仓库附带的许可行仍可展开，版权行与 MIT 原文都在", async () => {
  const view = render(
    <ThirdPartyNotices load={() => Promise.reject(new Error("清单缺失"))} />,
  );
  expect(await view.findByText("第三方依赖清单加载失败。")).not.toBeNull();
  fireEvent.click(view.getByRole("button", { name: holder }));
  expect(view.container.textContent).toContain(
    `Copyright (c) 2026 ${LICENCE_HOLDER}`,
  );
  expect(view.container.textContent).toContain("Permission is hereby granted");
});

test("设置侧栏有指向关于页的入口", () => {
  expect(
    SETTINGS_SIDEBAR_ITEMS.find((item) => item.title === "关于")?.linkOptions,
  ).toEqual({ to: "/settings/about" });
});
