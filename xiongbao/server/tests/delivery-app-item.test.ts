import { describe, expect, test } from "bun:test";
import { TOOL_BRIEFS } from "../src/agents/prompt-slim";
import { deliveredAppsOf } from "../src/computer/artifact-access";
import type { Database } from "../src/db/client";
import { deliveryProtocolGuidance } from "../src/tasks/delivery-tools";
import {
  type AppProbe,
  createEvidenceGate,
  type DeliveryItem,
} from "../src/tasks/evidence-gate";
import { uncheckedPhysical } from "../src/tasks/physical-gate";

/**
 * 交付项 `app`：交付里列一个正在运行的程序（端口、首页路径、名字），证据门实际请求一次首页确认它在跑。
 * 网关探针由测试替身代替；没有一项走数据库（只交程序的交付不查附件、组件）。
 */
const gateWith = (appProbe?: AppProbe) =>
  createEvidenceGate({} as Database, { appProbe });

const check = (
  items: DeliveryItem[],
  appProbe?: AppProbe,
  checks: string[] = ["打开首页看过了"],
) =>
  gateWith(appProbe).checkEvidence({
    tenantId: "t1",
    taskId: "k1",
    threadRef: null,
    items,
    checks,
    criteria: null,
    agentId: "a1",
  });

const todo = (extra: Partial<DeliveryItem> = {}): DeliveryItem => ({
  kind: "app",
  ref: "",
  title: "待办",
  port: 8000,
  ...extra,
});

describe("交付项 app", () => {
  test.each([80, 1023, 65536, 70000, 3.5])("端口 %p 挡回", async (port) => {
    const verdict = await check([todo({ port })], async () => ({
      status: 200,
    }));
    expect(verdict).toEqual({
      ok: false,
      reason: "程序「待办」的端口要在 1024 到 65535 之间。",
      missing: ["待办"],
    });
  });

  test("没写端口也挡回", async () => {
    const verdict = await check([todo({ port: undefined })]);
    expect(verdict.ok).toBe(false);
  });

  test("没有名字（title）挡回", async () => {
    const verdict = await check([todo({ title: undefined })]);
    expect(verdict.ok).toBe(false);
  });

  test.each(["index.html", "a\\b", "//x", "/a\nb"])(
    "路径 %p 不合规挡回",
    async (path) => {
      const verdict = await check([todo({ path })], async () => ({
        status: 200,
      }));
      expect(verdict).toEqual({
        ok: false,
        reason: "程序「待办」的路径不对，要以 / 开头。",
        missing: ["待办"],
      });
    },
  );

  test.each([200, 204, 302])("首页回 %p 通过，进 ref.apps", async (status) => {
    const asked: unknown[] = [];
    const verdict = await check([todo()], async (input) => {
      asked.push(input);
      return { status };
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.ref.apps).toEqual([
      { port: 8000, path: "/", title: "待办" },
    ]);
    expect(verdict.ref.unverifiedApps).toBeUndefined();
    expect(asked).toEqual([
      { tenantId: "t1", agentId: "a1", port: 8000, path: "/" },
    ]);
  });

  test("路径写了就请求那个路径", async () => {
    let seen = "";
    const verdict = await check(
      [todo({ path: "/app/?a=1" })],
      async (input) => {
        seen = input.path;
        return { status: 200 };
      },
    );
    expect(seen).toBe("/app/?a=1");
    expect(verdict.ok && verdict.ref.apps).toEqual([
      { port: 8000, path: "/app/?a=1", title: "待办" },
    ]);
  });

  test.each([404, 500])("首页回 %p 挡回", async (status) => {
    const verdict = await check([todo()], async () => ({ status }));
    expect(verdict).toEqual({
      ok: false,
      reason: `程序「待办」在端口 8000 上打不开（HTTP ${status} 或没有在监听）。先把它跑起来再交。`,
      missing: ["待办"],
    });
  });

  test("没有在监听（refused）挡回", async () => {
    const verdict = await check([todo()], async () => ({
      refused: "forbidden",
    }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("在端口 8000 上打不开");
  });

  test("设备座位探不了：通过，标未核实", async () => {
    const verdict = await check([todo()], async () => null);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.ref.apps).toEqual([
      { port: 8000, path: "/", title: "待办" },
    ]);
    expect(verdict.ref.unverifiedApps).toEqual([8000]);
  });

  test("同一端口同一路径交两次只记一项", async () => {
    const verdict = await check([todo(), todo()], async () => ({
      status: 200,
    }));
    expect(verdict.ok && verdict.ref.apps).toHaveLength(1);
  });

  test("没有探针时只看形状，不请求", async () => {
    const verdict = await check([todo()]);
    expect(verdict.ok).toBe(true);
  });

  test("只交程序的交付不被实物门挡回，即使验收标准提到程序", () => {
    expect(
      uncheckedPhysical({
        items: [todo()],
        criteria: "做一个程序",
        title: null,
        messages: [],
      }),
    ).toBe(false);
  });

  test("交出来的 apps，打开程序的鉴权读得到同一个端口", async () => {
    const verdict = await check([todo({ port: 8123 })], async () => ({
      status: 200,
    }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(deliveredAppsOf(verdict.ref.apps)).toEqual([
      { port: 8123, path: "/", title: "待办" },
    ]);
  });
});

describe("员工侧提示：程序也是交付项", () => {
  test("交付规约和 deliver_task 说明都点名 workspace_file / app", () => {
    const protocol = deliveryProtocolGuidance(["accept_task"]) ?? "";
    expect(protocol).toContain("workspace_file / app");
    expect(TOOL_BRIEFS.deliver_task?.description ?? "").toContain(
      "workspace_file / app",
    );
  });
});
