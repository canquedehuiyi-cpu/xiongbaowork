import { describe, expect, test } from "bun:test";
import {
  createHostAccessBroker,
  HostAccessRefusedError,
} from "../src/host-access/broker";

/*
 * 文件夹动作送到桌面时写的那一行（`onDispatch`，Activity 里的「电脑动作」）必须在调用答复之前落下，桌面
 * 拒绝时也一样。以前用 `Promise.all([queued, dispatched])`：桌面一拒绝，Promise.all 立刻按拒绝答复，不等
 * 那一行写完，于是拒绝那一行可能先写、送出那一行晚到（或在有人读 Activity 时还没写进去）。CI 上
 * `activity-folder-actions.integration.test.ts` 偶发少一条 host/write_file 的 computer.action_allowed 就是
 * 这个原因。
 */
const GRANT = "grant-dispatch-audit";

function brokerWithGrant() {
  const broker = createHostAccessBroker();
  broker.rememberGrant({
    id: GRANT,
    botId: "bot",
    actorId: "person",
    displayName: "Notes",
    revoked: false,
  });
  broker.nextDesktopOperation();
  return broker;
}

async function answerOnce(
  broker: ReturnType<typeof createHostAccessBroker>,
  answer: { ok: true; result: unknown } | { ok: false; error: string },
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const operation = broker.nextDesktopOperation()?.operations[0];
    if (operation) {
      broker.resolveDesktopOperation({
        operationId: operation.operationId,
        ...answer,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("the desktop was never handed an operation");
}

/** An `onDispatch` that takes its time, and says when it finished. */
function slowDispatch(ms: number) {
  const seen = { finished: false };
  return {
    seen,
    onDispatch: () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          seen.finished = true;
          resolve();
        }, ms),
      ),
  };
}

describe("the row written as a folder action goes to the desktop", () => {
  test("is written before a refused action is answered", async () => {
    const broker = brokerWithGrant();
    const { seen, onDispatch } = slowDispatch(60);
    const call = broker.callHost(
      {
        kind: "write_file",
        botId: "bot",
        actorId: "person",
        grantId: GRANT,
        relativePath: "todo.txt",
        content: "x",
      },
      { onDispatch },
    );
    await answerOnce(broker, {
      ok: false,
      error: "The local owner denied this operation.",
    });
    const error = await call.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HostAccessRefusedError);
    expect(seen.finished).toBe(true);
  });

  test("is written before a completed action is answered, as before", async () => {
    const broker = brokerWithGrant();
    const { seen, onDispatch } = slowDispatch(60);
    const call = broker.callHost(
      {
        kind: "read_file",
        botId: "bot",
        actorId: "person",
        grantId: GRANT,
        relativePath: "todo.txt",
      },
      { onDispatch },
    );
    await answerOnce(broker, { ok: true, result: { content: "buy milk" } });
    expect(await call).toEqual({ content: "buy milk" });
    expect(seen.finished).toBe(true);
  });

  test("a row that could not be written fails a completed action, as before", async () => {
    const broker = brokerWithGrant();
    const call = broker.callHost(
      {
        kind: "read_file",
        botId: "bot",
        actorId: "person",
        grantId: GRANT,
        relativePath: "todo.txt",
      },
      { onDispatch: () => Promise.reject(new Error("the trail is down")) },
    );
    await answerOnce(broker, { ok: true, result: { content: "buy milk" } });
    await expect(call).rejects.toThrow("the trail is down");
  });
});
