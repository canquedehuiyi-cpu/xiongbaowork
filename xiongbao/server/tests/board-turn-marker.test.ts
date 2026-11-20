import { expect, test } from "bun:test";
import { serverTurnScope } from "../src/routines/run-turn";
import { asPersonChat, boardTurnNow } from "../src/threads/unattended-card";

/*
 * 看板卡的一轮由派活的入口自己说（`boardCard`），经 `serverTurnScope` 让构建提示的地方读到；别的入口、
 * 单聊、从看板轮里起的别的轮都不带这个标记。
 */
const input = (extra: { boardCard?: boolean } = {}) => ({
  cardOwnedByCaller: true,
  ...extra,
});

test("boardCard 的一轮里读得到标记，没说的不带", async () => {
  expect(
    await serverTurnScope(input({ boardCard: true }), async () =>
      boardTurnNow(),
    ),
  ).toBe(true);
  expect(await serverTurnScope(input(), async () => boardTurnNow())).toBe(
    false,
  );
  expect(boardTurnNow()).toBe(false);
});

test("从看板轮里起的另一轮（没说 boardCard）不继承标记；单聊也没有", async () => {
  const inner = await serverTurnScope(input({ boardCard: true }), () =>
    serverTurnScope(input(), async () => boardTurnNow()),
  );
  expect(inner).toBe(false);
  expect(await asPersonChat(async () => boardTurnNow())).toBe(false);
});
