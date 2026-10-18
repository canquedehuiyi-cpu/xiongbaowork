import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  boardStats,
  ENDED_STATUSES,
  StatBar,
  shownForStatus,
} from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec A1/A2 and decision D-1 at the stat bar.
 *
 * Before this the four numbers were plain text and 已结束 counted `done` alone, so a board with eleven
 * failed cards read "已结束 0" (audit N5), and pressing a number did nothing although the reference
 * product filters by it.
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterEach(cleanup);
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const of = (...statuses: string[]) => statuses.map((status) => ({ status }));
const board = of(
  "running",
  "running",
  "needs_action",
  "awaiting_review",
  "done",
  "failed",
  "failed",
  "failed",
);

test("已结束 counts what is over -- done, failed and awaiting review -- and the parts add up to the total", () => {
  const values = Object.fromEntries(
    boardStats(board).map((stat) => [stat.label, stat.value]),
  );
  expect(values).toEqual({
    任务总数: "8",
    进行中: "2",
    需要操作: "1",
    已结束: "5",
  });
  expect(
    Number(values.进行中) + Number(values.需要操作) + Number(values.已结束),
  ).toBe(Number(values.任务总数));
});

test("a full page says 200+ instead of claiming a total it did not read", () => {
  const full = of(...Array.from({ length: 200 }, () => "done"));
  expect(boardStats(full)[0]?.value).toBe("200+");
});

test("the ended filter keeps exactly the three statuses it counts", () => {
  expect(
    shownForStatus(board, "ended")
      .map((task) => task.status)
      .sort(),
  ).toEqual(["awaiting_review", "done", "failed", "failed", "failed"]);
  // A copy: sorting the exported constant in place would reorder it for every later reader.
  expect([...ENDED_STATUSES].sort()).toEqual([
    "awaiting_review",
    "done",
    "failed",
  ]);
  // A real status was already applied by the server, so the list passes through untouched.
  expect(shownForStatus(board, "running")).toHaveLength(board.length);
});

test("each number is a button that says whether it is pressed, and pressing it again lets go", async () => {
  const chosen: string[] = [];
  const view = render(
    <StatBar
      onSelect={(status) => chosen.push(status)}
      status=""
      tasks={board}
    />,
  );

  const total = view.getByRole("button", { name: /任务总数/ });
  const ended = view.getByRole("button", { name: /已结束/ });
  expect(total.getAttribute("aria-pressed")).toBe("true");
  expect(ended.getAttribute("aria-pressed")).toBe("false");
  expect(ended.textContent).toContain("5");

  await userEvent.click(ended);
  expect(chosen).toEqual(["ended"]);

  view.rerender(
    <StatBar
      onSelect={(status) => chosen.push(status)}
      status="ended"
      tasks={board}
    />,
  );
  expect(
    view.getByRole("button", { name: /已结束/ }).getAttribute("aria-pressed"),
  ).toBe("true");
  await userEvent.click(view.getByRole("button", { name: /已结束/ }));
  expect(chosen).toEqual(["ended", ""]);

  // The rule is said on the screen, not left for a person to reverse-engineer from the numbers.
  expect(view.getByText(/已结束 = 已完成 \+ 失败 \+ 待查收/)).toBeTruthy();
});
