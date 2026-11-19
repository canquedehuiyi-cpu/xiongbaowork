import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SETTINGS_SIDEBAR_ITEMS } from "@/components/settings/settings-sidebar";
import { appConfig } from "@/lib/generated/application-config";
import { AboutPage } from "@/routes/_authed/settings/about";
import { settleReactWork } from "./settle-react-work";

/*
 * 关于页：产品名、版本、公司名，OpenBot 的 MIT 声明，以及第三方依赖清单。真实清单有 1.8 MB，
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

function open() {
  const router = createRouter({
    routeTree: createRootRoute({ component: AboutPage }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router as never} />);
}

test("关于页写明公司名、OpenBot 的版权行和 MIT 全文，且不带上游仓库链接", async () => {
  const view = open();
  expect(await view.findByText("Copyright (c) 2026 CopilotKit")).not.toBeNull();
  expect(view.container.textContent).toContain("Permission is hereby granted");
  expect(view.container.textContent).toContain(
    `© 2026 ${appConfig.brand.companyName}`,
  );
  expect(view.container.textContent).toContain(appConfig.brand.productName);
  expect(view.container.innerHTML).not.toContain("github.com/CopilotKit");
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

test("设置侧栏有指向关于页的入口", () => {
  expect(
    SETTINGS_SIDEBAR_ITEMS.find((item) => item.title === "关于")?.linkOptions,
  ).toEqual({ to: "/settings/about" });
});
