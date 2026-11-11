import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { PageShell } from "@/components/layout/page-shell";
import { SidebarProvider } from "@/components/ui/sidebar";

/*
 * The workbench pages share one frame (docs/design/ios-studio): a 61px breadcrumb bar with a hairline
 * under it, then an open heading — a red-dashed eyebrow, a large tight title, a quiet line — over a
 * full-width column whose gutter grows from 13px on a phone to 47px on a wide screen. The reading
 * pages keep their centred columns.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
});
afterEach(() => {
  cleanup();
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

function frameOf(width?: "prose" | "wide" | "workbench") {
  const view = render(
    <SidebarProvider>
      <PageShell title="任务看板" width={width}>
        <p>正文</p>
      </PageShell>
    </SidebarProvider>,
  );
  const heading = view.getByRole("heading", { level: 1, name: "任务看板" });
  const frame = heading.closest("header")?.parentElement;
  if (!frame) throw new Error("no frame");
  const classes = frame.className.split(/\s+/);
  cleanup();
  return classes;
}

test("a workbench page is full width under an open heading with an eyebrow, a large title and a quiet line", () => {
  const classes = frameOf("workbench");
  expect(classes).toEqual(
    expect.arrayContaining([
      "w-full",
      "max-w-[1750px]",
      "px-[13px]",
      "md:px-[clamp(21px,3vw,47px)]",
    ]),
  );
  const view = render(
    <SidebarProvider>
      <PageShell
        description="说明"
        eyebrow="01 WORK RECORD"
        title="任务看板"
        width="workbench"
      >
        <p>正文</p>
      </PageShell>
    </SidebarProvider>,
  );
  const heading = view.getByRole("heading", { level: 1, name: "任务看板" });
  expect(heading.className).toContain("text-[clamp(35px,4.5vw,55px)]");
  expect(view.getByText("说明").className).toContain("text-[13px]");
  const eyebrow = view.container.querySelector("[data-slot=eyebrow]");
  expect(eyebrow?.textContent).toBe("01WORK RECORD");
});

test("the breadcrumb bar names the page after 工作台, and a Back link takes 工作台's place", () => {
  const view = render(
    <SidebarProvider>
      <PageShell title="任务看板" width="workbench">
        <p>正文</p>
      </PageShell>
    </SidebarProvider>,
  );
  const crumbs = view.getByRole("navigation", { name: "当前位置" });
  expect(crumbs.textContent).toBe("工作台任务看板");
  expect(crumbs.querySelector("[aria-current=page]")?.textContent).toBe(
    "任务看板",
  );
});

test("the reading widths are unchanged", () => {
  expect(frameOf()).toEqual(expect.arrayContaining(["mx-auto", "max-w-2xl"]));
  expect(frameOf("wide")).toEqual(
    expect.arrayContaining(["mx-auto", "max-w-5xl"]),
  );
});

test("on a phone the gutter narrows and the header's actions wrap below the title instead of squeezing it", () => {
  const view = render(
    <SidebarProvider>
      <PageShell
        action={<button type="button">新建员工</button>}
        title="员工管理"
        width="workbench"
      >
        <p>正文</p>
      </PageShell>
    </SidebarProvider>,
  );
  const heading = view.getByRole("heading", { level: 1, name: "员工管理" });
  expect(heading.closest("header")?.className).toContain("flex-wrap");
  expect(heading.className).toContain("max-w-full");
});

function renderAt(path: string) {
  const page = (title: string) => () => (
    <SidebarProvider>
      <PageShell title={title} width="workbench">
        <p>正文</p>
      </PageShell>
    </SidebarProvider>
  );
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([
      createRoute({
        component: page("任务看板"),
        getParentRoute: () => root,
        path: "/tasks",
      }),
      createRoute({
        component: page("设置"),
        getParentRoute: () => root,
        path: "/settings",
      }),
    ]),
  });
  return render(<RouterProvider router={router} />);
}

test("the 熊宝小管家 dock sits in the bar of the five workbench pages and opens /bot", async () => {
  const view = renderAt("/tasks");
  const dock = await view.findByRole("link", { name: "小管家" });
  expect(dock.getAttribute("href")).toBe("/bot");
  expect(within(dock).getByRole("img", { name: "熊宝" })).toBeTruthy();
  expect(view.getByRole("navigation", { name: "当前位置" }).textContent).toBe(
    "工作台任务看板",
  );
});

test("a settings page in the same frame names 设置 and carries no dock", async () => {
  const view = renderAt("/settings");
  const crumbs = await view.findByRole("navigation", { name: "当前位置" });
  expect(crumbs.textContent).toBe("设置设置");
  expect(view.queryByRole("link", { name: "小管家" })).toBeNull();
});
