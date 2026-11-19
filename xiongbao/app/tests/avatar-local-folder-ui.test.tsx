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
import type { AvatarSource } from "@/lib/avatar/sources";
import type { RegisteredDevice } from "@/lib/devices/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Story F1, stage 2 (S2): a folder on the person's own machine as their 分身's information source.
 *
 * The 本地文件夹 option lists the folders the person's online machines report (a name and an opaque
 * reference, never a path), saves the one picked by its machine and reference, and with no paired
 * machine shows how to pair one while the other kind can still be saved (D4). Both places: the
 * onboarding step and the 分身's detail panel. The fetch is faked and records every call.
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
const WORK = "fld_AAAAAAAAAAAAAAAAAAAAAA";
const CONTRACTS = "fld_BBBBBBBBBBBBBBBBBBBBBB";
const PRIVATE = "fld_CCCCCCCCCCCCCCCCCCCCCC";

const study: RegisteredDevice = {
  id: "row-1",
  deviceId: "study-pc",
  name: "书房电脑",
  platform: "win32",
  lastSeenAt: "2026-11-04T00:00:00.000Z",
  online: true,
  roots: [
    { ref: WORK, name: "工作资料" },
    { ref: CONTRACTS, name: "合同" },
  ],
};
const laptop: RegisteredDevice = {
  id: "row-2",
  deviceId: "old-laptop",
  name: "旧笔记本",
  platform: "darwin",
  lastSeenAt: "2026-10-01T00:00:00.000Z",
  online: false,
  roots: [{ ref: PRIVATE, name: "私人" }],
};

/** The sources endpoint as the server keeps it, and a device list as it reports them. */
function serve(options: {
  sources?: AvatarSource[];
  devices: RegisteredDevice[];
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
    if (path === "/api/devices")
      return Response.json({ devices: options.devices });
    if (path === "/api/me/avatar/sources" && method === "GET")
      return Response.json({
        agentId: AVATAR,
        configuredAt: sources.length ? "2026-11-04T00:00:00.000Z" : null,
        sources,
      });
    if (path === "/api/me/avatar/sources" && method === "POST") {
      const root = [...study.roots!, ...laptop.roots!].find(
        (entry) => entry.ref === body.rootRef,
      );
      const source: AvatarSource =
        body.kind === "local_folder"
          ? {
              id: `33333333-3333-4333-8333-33333333333${sources.length}`,
              kind: "local_folder",
              label: body.label || root?.name || "",
              note: body.note,
              deviceId: body.deviceId,
              rootRef: body.rootRef,
              createdAt: "2026-11-04T01:00:00.000Z",
            }
          : {
              id: `44444444-4444-4444-8444-44444444444${sources.length}`,
              kind: "declaration",
              label: body.label,
              note: body.note,
              createdAt: "2026-11-04T01:00:00.000Z",
            };
      sources = [...sources, source];
      return Response.json({ source }, { status: 201 });
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
const FOLDER_CONSENT = "我已了解，分身读取的文件内容会发送给模型服务";

test("the detail panel lists the folders the online machines offer, and saves the one picked by machine and reference", async () => {
  serve({ devices: [study, laptop] });
  const { view, user } = draw(<AvatarSourcesPanel />);
  await view.findByText("还没有登记信息来源。");

  await user.click(button(view, "本地文件夹"));
  const picker = within(
    (await view.findByText("选择一个文件夹")).closest(
      "fieldset",
    ) as HTMLElement,
  );
  expect(picker.getByLabelText(/工作资料/)).toBeTruthy();
  expect(picker.getByLabelText(/合同/)).toBeTruthy();
  // Each with the machine it is on.
  expect(picker.getAllByText(/· 书房电脑/)).toHaveLength(2);
  // An offline machine's folder is not offered.
  expect(view.queryByText(/私人/)).toBeNull();
  // What it sends the model is said before anything can be saved.
  expect(
    view.getByText(/只能读取这个文件夹，不能修改、删除或在里面运行命令/),
  ).toBeTruthy();

  await user.click(picker.getByLabelText(/合同/));
  const add = button(view, "添加信息来源");
  expect(add.disabled).toBeTrue();
  await user.click(view.getByRole("checkbox", { name: FOLDER_CONSENT }));
  await user.type(view.getByLabelText("文件夹说明（可选）"), "客户合同");
  await user.click(add);

  const saved = within(
    await view.findByRole("list", { name: "已登记的信息来源" }),
  );
  expect(await saved.findByText("合同")).toBeTruthy();
  expect(await saved.findByText("本地文件夹 · 书房电脑")).toBeTruthy();
  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/api/me/avatar/sources",
      body: {
        kind: "local_folder",
        deviceId: "study-pc",
        rootRef: CONTRACTS,
        label: "",
        note: "客户合同",
      },
    },
  ]);
  // Saved once is saved: the same folder is no longer offered for a second save.
  await waitFor(() =>
    expect(
      (picker.getByLabelText(/合同/) as HTMLInputElement).disabled,
    ).toBeTrue(),
  );
  expect(picker.getByText(/已登记/)).toBeTruthy();
  // Nothing on this screen ever carried a path.
  expect(JSON.stringify(calls)).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
});

test("with no paired machine the panel shows how to pair one, links to My Devices, and still saves a declaration (D4)", async () => {
  serve({ devices: [] });
  const { view, user } = draw(<AvatarSourcesPanel />);
  await view.findByText("还没有登记信息来源。");

  await user.click(button(view, "本地文件夹"));
  expect(await view.findByText("还没有配对的设备")).toBeTruthy();
  const link = view.getByRole("link", { name: "前往「我的设备」配对电脑" });
  expect(link.getAttribute("href")).toBe("/settings");
  expect(view.queryByText("选择一个文件夹")).toBeNull();

  await user.click(button(view, "文字声明"));
  await user.type(view.getByLabelText("名称"), "周报");
  await user.click(
    view.getByRole("checkbox", {
      name: "我已了解，信息来源的说明会发送给模型服务",
    }),
  );
  await user.click(button(view, "添加信息来源"));
  await waitFor(() =>
    expect(writes()).toEqual([
      {
        method: "POST",
        path: "/api/me/avatar/sources",
        body: { kind: "declaration", label: "周报", note: "" },
      },
    ]),
  );
});

test("machines that are all offline, or offer no folder yet, say so instead of an empty list", async () => {
  serve({ devices: [laptop] });
  const offline = draw(<AvatarSourcesPanel />);
  await offline.view.findByText("还没有登记信息来源。");
  await offline.user.click(button(offline.view, "本地文件夹"));
  expect(await offline.view.findByText(/你的设备目前都不在线/)).toBeTruthy();
  cleanup();

  serve({ devices: [{ ...study, roots: [] }] });
  const empty = draw(<AvatarSourcesPanel />);
  await empty.view.findByText("还没有登记信息来源。");
  await empty.user.click(button(empty.view, "本地文件夹"));
  expect(
    await empty.view.findByText(/你的设备还没有提供本地文件夹/),
  ).toBeTruthy();
});

test("a saved folder the machine no longer offers is shown as such", async () => {
  serve({
    devices: [{ ...study, roots: [{ ref: WORK, name: "工作资料" }] }],
    sources: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        kind: "local_folder",
        label: "合同",
        note: "",
        deviceId: "study-pc",
        rootRef: CONTRACTS,
        createdAt: "2026-11-04T00:00:00.000Z",
      },
    ],
  });
  const { view } = draw(<AvatarSourcesPanel />);
  expect(
    await view.findByText("本地文件夹 · 书房电脑 · 设备上已不再提供这个文件夹"),
  ).toBeTruthy();
});

test("in onboarding a folder can be picked and saved before moving on; with no machine the step says where to pair and can still be skipped", async () => {
  serve({ devices: [study] });
  let advanced = 0;
  const first = draw(
    <SourcesStep nextStep={2} onAdvanced={() => (advanced += 1)} />,
  );
  await first.view.findByText("还没有登记信息来源。");
  await first.user.click(button(first.view, "本地文件夹"));
  await first.user.click(await first.view.findByLabelText(/工作资料/));
  expect(button(first.view, "保存并继续").disabled).toBeTrue();
  await first.user.click(
    first.view.getByRole("checkbox", { name: FOLDER_CONSENT }),
  );
  await first.user.click(button(first.view, "保存并继续"));
  await waitFor(() => expect(advanced).toBe(1));
  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/api/me/avatar/sources",
      body: {
        kind: "local_folder",
        deviceId: "study-pc",
        rootRef: WORK,
        label: "",
        note: "",
      },
    },
    { method: "POST", path: "/api/me/onboarding", body: { step: 2 } },
  ]);
  cleanup();
  calls.length = 0;

  serve({ devices: [] });
  const second = draw(
    <SourcesStep nextStep={2} onAdvanced={() => (advanced += 1)} />,
  );
  await second.view.findByText("还没有登记信息来源。");
  await second.user.click(button(second.view, "本地文件夹"));
  expect(await second.view.findByText("还没有配对的设备")).toBeTruthy();
  // The rest of the app opens after onboarding, so the step names the place rather than linking.
  expect(second.view.getByText(/「设置 ›\s*我的设备」/)).toBeTruthy();
  expect(second.view.queryByRole("link")).toBeNull();
  expect(button(second.view, "保存并继续").disabled).toBeTrue();
  await second.user.click(button(second.view, "跳过，稍后在分身详情页配置"));
  await waitFor(() => expect(advanced).toBe(2));
  expect(writes()).toEqual([
    { method: "POST", path: "/api/me/onboarding", body: { step: 2 } },
  ]);
});
