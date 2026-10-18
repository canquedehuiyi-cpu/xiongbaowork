import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowStartedNotice } from "@/components/channels/group-chat";
import { settleReactWork } from "./settle-react-work";

/**
 * What a person sees after "@小组 做X" in a group (WP-2.4).
 *
 * Starting a crew posts nothing into the transcript, by design: the steps are not lines in this
 * conversation. Checked live on 2026-10-09, the composer simply emptied and nothing else moved, which
 * reads exactly like a message that was lost. This is the sentence that says it was not.
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

function draw(onDismiss: () => void) {
  const root = createRootRoute({
    component: () => (
      <FlowStartedNotice label="研发小组" onDismiss={onDismiss} runId="run-7" />
    ),
  });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/pipelines",
        component: () => null,
      } as never),
    ]),
  });
  return render(<RouterProvider router={router} />);
}

test("it names the crew that took the task and links to that run", async () => {
  const view = draw(() => {});

  const status = await view.findByRole("status");
  expect(status.textContent).toContain("已交给「研发小组」开始流程");
  expect(
    view.getByRole("link", { name: "查看这次运行" }).getAttribute("href"),
  ).toBe("/pipelines?run=run-7");
});

test("it can be dismissed", async () => {
  let dismissed = 0;
  const view = draw(() => {
    dismissed += 1;
  });

  await userEvent.click(
    await view.findByRole("button", { name: "关闭这条提示" }),
  );
  expect(dismissed).toBe(1);
});
