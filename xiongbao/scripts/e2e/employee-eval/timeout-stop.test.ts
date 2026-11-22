import { expect, test } from "bun:test";
import { RUN_PATH } from "../chat-client";
import { runsToStop, stopLine, stopPath, stopRunning } from "./timeout-stop";

function clock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}

test("只有状态是 running 的轮还要停；没有记录和已结束的不用，重复的只算一次", () => {
  expect(
    runsToStop([
      { runId: "a", status: "running" },
      { runId: "b", status: "finished" },
      { runId: "c", status: undefined },
      { runId: "d", status: "interrupted" },
      { runId: "a", status: "running" },
      { runId: "e", status: "running" },
    ]),
  ).toEqual(["a", "e"]);
});

test("对还在跑的每一轮调停止，等它们变成非 running", async () => {
  const status = new Map<string, string>([
    ["r1", "finished"],
    ["r2", "running"],
    ["r3", "running"],
  ]);
  const stopped: string[] = [];
  const out = await stopRunning({
    runIds: ["r1", "r2", "r3"],
    statusOf: async (id) => status.get(id),
    stop: async (id) => {
      stopped.push(id);
      // r2 马上停下，r3 要再等一会儿。
      if (id === "r2") status.set(id, "interrupted");
      else setTimeout(() => status.set(id, "interrupted"), 0);
      return true;
    },
    ...clock(),
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  });
  expect(stopped).toEqual(["r2", "r3"]);
  expect(out).toEqual({ running: 2, stopped: 2, stillRunning: 0 });
  expect(stopLine(out)).toBe("   超时：已停掉服务器上还在跑的 2 轮");
});

test("没有还在跑的轮就不调停止", async () => {
  let called = 0;
  const out = await stopRunning({
    runIds: ["r1"],
    statusOf: async () => "finished",
    stop: async () => {
      called += 1;
      return true;
    },
    ...clock(),
  });
  expect(called).toBe(0);
  expect(out).toEqual({ running: 0, stopped: 0, stillRunning: 0 });
  expect(stopLine(out)).toBe("   超时：服务器上没有还在跑的轮");
});

test("停止被拒或抛错、读状态失败都不抛，等满 30 秒后报还在跑的轮数", async () => {
  const time = clock();
  const out = await stopRunning({
    runIds: ["r1", "r2"],
    statusOf: async (id) => {
      if (id === "r2") throw new Error("db down");
      return "running";
    },
    stop: async (id) => {
      if (id === "r1") return false;
      throw new Error("HTTP 500");
    },
    ...time,
  });
  expect(out).toEqual({ running: 2, stopped: 0, stillRunning: 2 });
  expect(time.now()).toBeGreaterThanOrEqual(30_000);
  expect(stopLine(out)).toBe(
    "   超时：已停掉服务器上还在跑的 0 轮，另有 2 轮 30 秒内没停下",
  );
});

test("停止接口和单聊运行接口同一前缀，结尾是 /stop/:对话（id 要转义）", () => {
  const run = RUN_PATH("a b");
  expect(stopPath("a b", "t/1")).toBe(
    `${run.slice(0, -"/run".length)}/stop/t%2F1`,
  );
  expect(stopPath("a b", "t1").endsWith("/agent/a%20b/stop/t1")).toBe(true);
});
