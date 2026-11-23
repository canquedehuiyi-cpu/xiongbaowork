import { describe, expect, test } from "bun:test";
import { ComputerUnavailableError } from "../src/computer/gateway";
import { type AppProbeGateway, createAppProbe } from "../src/tasks/app-probe";

/**
 * 证据门请求程序首页的探针：设备部署和电脑不可达都算「未核实」（null），其余失败算打不开，
 * 找座位也在同一个 10 秒总时限里。网关由替身代替。
 */
const ask = { tenantId: "t1", agentId: "a1", port: 8000, path: "/" };

function gatewayOf(
  parts: {
    machine?: "workspace" | "device";
    seatFor?: () => Promise<unknown>;
    forwardHttp?: () => Promise<{
      status: number;
      body: ReadableStream | null;
    }>;
  } = {},
) {
  const calls: string[] = [];
  const gateway = {
    machine: () => {
      calls.push("machine");
      return parts.machine ?? "workspace";
    },
    seatFor: async () => {
      calls.push("seatFor");
      return parts.seatFor ? parts.seatFor() : { botId: "a1" };
    },
    forwardHttp: async () => {
      calls.push("forwardHttp");
      return parts.forwardHttp
        ? parts.forwardHttp()
        : { status: 200, body: null };
    },
  } as unknown as AppProbeGateway;
  return { gateway, calls };
}

describe("程序首页探针", () => {
  test("设备部署：不找座位、不请求，标未核实", async () => {
    const { gateway, calls } = gatewayOf({ machine: "device" });
    expect(await createAppProbe(gateway)(ask)).toBeNull();
    expect(calls).toEqual(["machine"]);
  });

  test("首页回什么状态就报什么状态", async () => {
    const { gateway } = gatewayOf({
      forwardHttp: async () => ({ status: 404, body: null }),
    });
    expect(await createAppProbe(gateway)(ask)).toEqual({ status: 404 });
  });

  test("电脑回 403（不是这个 Bot 的端口或没有在监听）报 refused", async () => {
    const { gateway } = gatewayOf({
      forwardHttp: async () => ({ status: 403, body: null }),
    });
    expect(await createAppProbe(gateway)(ask)).toEqual({
      refused: "forbidden",
    });
  });

  test("找座位时电脑不可达：未核实，不当作打不开", async () => {
    const { gateway } = gatewayOf({
      seatFor: async () => {
        throw new ComputerUnavailableError("The Bot's computer isn't running.");
      },
    });
    expect(await createAppProbe(gateway)(ask)).toBeNull();
  });

  test("请求时电脑不可达：未核实", async () => {
    const { gateway } = gatewayOf({
      forwardHttp: async () => {
        throw new ComputerUnavailableError("That port cannot be forwarded to.");
      },
    });
    expect(await createAppProbe(gateway)(ask)).toBeNull();
  });

  test("其它错误按打不开挡回", async () => {
    const { gateway } = gatewayOf({
      forwardHttp: async () => {
        throw new Error("connection refused");
      },
    });
    expect(await createAppProbe(gateway)(ask)).toEqual({
      refused: "unreachable",
    });
  });

  test("找座位卡住也受总时限管：超时按打不开", async () => {
    const { gateway, calls } = gatewayOf({
      seatFor: () => new Promise(() => undefined),
    });
    expect(await createAppProbe(gateway, 30)(ask)).toEqual({
      refused: "unreachable",
    });
    expect(calls).toEqual(["machine", "seatFor"]);
  });

  test("请求卡住同样受总时限管", async () => {
    const { gateway } = gatewayOf({
      forwardHttp: () => new Promise(() => undefined),
    });
    expect(await createAppProbe(gateway, 30)(ask)).toEqual({
      refused: "unreachable",
    });
  });
});
