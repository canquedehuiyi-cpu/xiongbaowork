import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { LabeledSelect } from "@/components/layout/labeled-select";
import { SearchBox } from "@/components/layout/search-box";
import {
  SegmentedTabs,
  tabPanelProps,
} from "@/components/layout/segmented-tabs";
import { WorkbenchEmpty } from "@/components/layout/workbench-empty";

/*
 * The controls every workbench page shares, shaped after the reference screenshots in
 * docs/acceptance/qoderwake-reference/: a 32px filter box that names itself in grey before its value
 * ("运行状态 在线 ▾"), a search box with the magnifier at its start, underline tabs (需要操作 /
 * 查收结果, 插件市场 / 我的插件, the sidebar's 员工 / 群组) and an empty state with our own mascot.
 */

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost:3010" });
    registeredHere = true;
  }
});
afterEach(() => {
  cleanup();
});
afterAll(() => {
  if (registeredHere) GlobalRegistrator.unregister();
});

test("a labeled select shows its name before its value and reports changes", async () => {
  function Harness() {
    const [value, setValue] = useState("all");
    return (
      <LabeledSelect
        label="运行状态"
        onValueChange={setValue}
        options={[
          { value: "all", label: "全部" },
          { value: "online", label: "在线" },
        ]}
        value={value}
      />
    );
  }
  const view = render(<Harness />);
  const select = view.getByRole("combobox", { name: "运行状态" });
  const box = select.closest("[data-slot=labeled-select]");
  expect(box?.className).toContain("h-[32px]");
  expect(box?.textContent).toContain("运行状态");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.selectOptions(select, "online");
  expect((select as HTMLSelectElement).value).toBe("online");
});

test("a search box is a 32px labelled input with the magnifier at its start", async () => {
  function Harness() {
    const [value, setValue] = useState("");
    return (
      <SearchBox
        label="搜索任务"
        onValueChange={setValue}
        placeholder="搜索任务、员工或群组"
        value={value}
      />
    );
  }
  const view = render(<Harness />);
  const input = view.getByRole("searchbox", { name: "搜索任务" });
  expect(input.getAttribute("placeholder")).toBe("搜索任务、员工或群组");
  expect(
    input.closest("[data-slot=search-box]")?.className.includes("h-[32px]"),
  ).toBe(true);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(input, "周报");
  expect((input as HTMLInputElement).value).toBe("周报");
});

test("underline tabs mark the selected tab with an underline and keep arrow-key movement", async () => {
  function Harness() {
    const [value, setValue] = useState<"a" | "b">("a");
    return (
      <SegmentedTabs
        label="关注分类"
        onValueChange={setValue}
        tabs={[
          { value: "a", label: "需要操作", count: 2 },
          { value: "b", label: "查收结果", count: 0 },
        ]}
        value={value}
        variant="underline"
      />
    );
  }
  const view = render(<Harness />);
  const list = view.getByRole("tablist", { name: "关注分类" });
  expect(list.getAttribute("data-variant")).toBe("underline");
  const first = view.getByRole("tab", { name: /需要操作/ });
  expect(first.getAttribute("aria-selected")).toBe("true");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  first.focus();
  await user.keyboard("{ArrowRight}");
  expect(
    view.getByRole("tab", { name: /查收结果/ }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("the empty state draws our own mascot and says what is missing", () => {
  const view = render(
    <WorkbenchEmpty
      description="当前筛选条件下没有可展示的任务。"
      title="暂无任务"
    />,
  );
  expect(view.getByRole("img", { name: "熊宝" })).toBeTruthy();
  expect(view.getByText("暂无任务")).toBeTruthy();
  expect(view.getByText("当前筛选条件下没有可展示的任务。")).toBeTruthy();
});

test("the empty state can greet with any of the character sheet's expressions", () => {
  const view = render(<WorkbenchEmpty mood="cute" title="还没有群组" />);
  const mascot = view.getByRole("img", { name: "熊宝" });
  expect(mascot.getAttribute("data-mood")).toBe("cute");
  expect(mascot.getAttribute("src")).toContain("xiongbao-cute");
});

test("without a mood the empty state's 熊宝 is the happy one", () => {
  const view = render(<WorkbenchEmpty title="暂无任务" />);
  expect(
    view.getByRole("img", { name: "熊宝" }).getAttribute("data-mood"),
  ).toBe("happy");
});

test("tabs say whether a change came from the keyboard, so callers can replace history instead of pushing", async () => {
  const changes: { value: string; keyboard: boolean }[] = [];
  const view = render(
    <SegmentedTabs
      label="视图"
      onValueChange={(value, change) =>
        changes.push({ value, keyboard: change.keyboard })
      }
      tabs={[
        { value: "a", label: "列表" },
        { value: "b", label: "泳道" },
      ]}
      value="a"
    />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("tab", { name: "泳道" }));
  view.getByRole("tab", { name: "列表" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(changes).toEqual([
    { value: "b", keyboard: false },
    { value: "b", keyboard: true },
  ]);
});

test("with a panel id, each tab controls the panel and the panel is labelled by the selected tab", () => {
  const view = render(
    <>
      <SegmentedTabs
        label="员工与群组"
        onValueChange={() => {}}
        panelId="wall"
        tabs={[
          { value: "coworkers", label: "员工" },
          { value: "groups", label: "群组" },
        ]}
        value="groups"
      />
      <div {...tabPanelProps("wall", "groups")}>内容</div>
    </>,
  );
  for (const tab of view.getAllByRole("tab")) {
    expect(tab.getAttribute("aria-controls")).toBe("wall");
  }
  const panel = view.getByRole("tabpanel", { name: "群组" });
  expect(panel.textContent).toBe("内容");
});
