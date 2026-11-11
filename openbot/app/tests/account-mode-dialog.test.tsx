// app/tests/account-mode-dialog.test.tsx
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountModeDialog } from "../src/components/plugins/account-mode-dialog";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
const sent: { body: unknown }[] = [];
let failing = false;
/** X7 安全评审后：会话写着 admin、但角色已被收回的人切换时，服务端答 403 和这一句。 */
const ADMIN_UNCONFIRMED = "你的管理员身份没能确认，没有改变任何东西。";
let demoted = false;
beforeEach(() => {
  sent.length = 0;
  failing = false;
  demoted = false;
  global.fetch = Object.assign(
    async (_path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ body });
      if (body?.confirm === false) {
        return Response.json({
          changed: false,
          preview: {
            mode: "shared",
            wouldRevoke: { holder: "person", count: 14 },
            bots: [
              {
                botId: "triage",
                exposure: { audience: "team", outsideInput: true, members: [] },
              },
            ],
          },
        });
      }
      if (demoted)
        return Response.json({ error: ADMIN_UNCONFIRMED }, { status: 403 });
      if (failing)
        return Response.json(
          {
            changed: false,
            failures: [{ account: "u2", error: "Composio said no." }],
            error: "Composio said no.",
          },
          { status: 502 },
        );
      return Response.json({ changed: true, revoked: 14 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AccountModeDialog
        onOpenChange={() => {}}
        open
        serverId="linear"
        target="shared"
        title="Linear"
      />
    </QueryClientProvider>,
  );
}

describe("switching an app to Shared", () => {
  test("names what goes, warns, and lists each Bot's approval before anything changes", async () => {
    const view = draw();
    expect(await view.findByText("14 个个人账号会被断开。")).toBeTruthy();
    expect(
      view.getByText(
        "用到这个应用的员工，不管谁在用，都会以这一个账号行事。下面是每位员工切换后会被批准的使用范围。",
      ),
    ).toBeTruthy();
    expect(view.getByText(/triage/)).toBeTruthy();
    expect(view.getByText(/所有人，也接受外部输入/)).toBeTruthy();
    expect(sent).toEqual([{ body: { mode: "shared", confirm: false } }]);
  });

  /*
   * 熊宝（X7）：服务端切换时不自己记共享使用批准，所以确认时把预览里每位员工的使用范围作为 `approvals`
   * 送回；上游前端不送。
   */
  test("confirming sends the switch once, with each listed Bot's approval", async () => {
    const view = draw();
    await userEvent.click(
      await view.findByRole("button", { name: "把 Linear 改成团队账号" }),
    );
    expect(sent.at(-1)).toEqual({
      body: {
        mode: "shared",
        confirm: true,
        approvals: {
          triage: { audience: "team", outsideInput: true, members: [] },
        },
      },
    });
  });

  test("a vendor that refuses a revoke is shown in the dialog, which stays open", async () => {
    failing = true;
    const view = draw();
    await userEvent.click(
      await view.findByRole("button", { name: "把 Linear 改成团队账号" }),
    );
    expect(await view.findByText("Composio said no.")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "把 Linear 改成团队账号" }),
    ).toBeTruthy();
  });

  test("an admin whose role was taken back is shown the server's sentence, and nothing reads as changed", async () => {
    demoted = true;
    const view = draw();
    await userEvent.click(
      await view.findByRole("button", { name: "把 Linear 改成团队账号" }),
    );
    expect(await view.findByText(ADMIN_UNCONFIRMED)).toBeTruthy();
    expect(
      view.getByRole("button", { name: "把 Linear 改成团队账号" }),
    ).toBeTruthy();
  });
});
