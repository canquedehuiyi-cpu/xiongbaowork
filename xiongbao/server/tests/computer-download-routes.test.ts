import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { personSeat } from "../src/computer/computer-key";
import type { ComputerGateway } from "../src/computer/gateway";
import {
  ActionRefusedError,
  ComputerUnavailableError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
  WorkspaceTooLargeError,
} from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

const member: AuthenticatedActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

function asActor(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", member);
    await next();
  };
}

function appFor(
  gateway: ComputerGateway,
  canUseBot: (
    actor: AuthenticatedActor,
    botId: string,
  ) => Promise<boolean> = async () => true,
) {
  return createComputerRoutes(gateway, {} as PolicyStore, asActor(), canUseBot);
}

function gatewayThatReturns(name: string, bytes: Uint8Array) {
  const calls: Array<{
    botId: string;
    actorId: string;
    path: string;
  }> = [];
  const gateway = {
    seatFor: async (botId: string, personId: string) =>
      personSeat(personId, botId),
    downloadFile: async (
      seat: { botId: string },
      actor: { id: string },
      input: { path: string },
    ) => {
      calls.push({ botId: seat.botId, actorId: actor.id, path: input.path });
      return {
        body: bytes,
        bytes: bytes.byteLength,
        name,
      };
    },
  } as unknown as ComputerGateway;
  return { gateway, calls };
}

describe("the public computer file download route", () => {
  test("returns raw bytes under safe attachment headers", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 255]);
    const { gateway, calls } = gatewayThatReturns("report.pdf", bytes);
    const response = await appFor(gateway).request(
      "http://openbot.test/bot-17/files/download?path=%20reports%2Freport.pdf%20",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(calls).toEqual([
      { botId: "bot-17", actorId: "user-1", path: "reports/report.pdf" },
    ]);
  });

  test("cannot add response headers through the filename", async () => {
    const { gateway } = gatewayThatReturns(
      "evil\r\nX-Injected: yes.txt",
      Uint8Array.from([1]),
    );
    const response = await appFor(gateway).request(
      "http://openbot.test/bot-17/files/download?path=evil.txt",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    expect(response.headers.get("x-injected")).toBeNull();
  });

  test("refuses a missing path before asking the gateway", async () => {
    const { gateway, calls } = gatewayThatReturns("x", Uint8Array.from([1]));
    const response = await appFor(gateway).request(
      "http://openbot.test/bot-17/files/download",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A file path is required.",
    });
    expect(calls).toHaveLength(0);
  });

  test("applies Bot ownership before asking the gateway", async () => {
    const { gateway, calls } = gatewayThatReturns("x", Uint8Array.from([1]));
    const response = await appFor(gateway, async () => false).request(
      "http://openbot.test/somebody-elses-bot/files/download?path=x",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "There is no such Bot.",
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    [
      "a policy refusal",
      new ActionRefusedError("Blocked by policy.", "file.extension == 'env'"),
      403,
    ],
    ["a workspace refusal", new WorkspaceRefusedError("Outside."), 403],
    ["a bad path", new WorkspaceRequestError("A path is required."), 400],
    ["a missing file", new WorkspaceNotFoundError("No such file."), 404],
    ["an oversized file", new WorkspaceTooLargeError("Too large."), 413],
    [
      "an unavailable computer",
      new ComputerUnavailableError("The computer is not running."),
      503,
    ],
    ["an unexpected failure", new Error("Boom."), 500],
  ])("maps %s to %i", async (_name, error, status) => {
    const gateway = {
      seatFor: async (botId: string, personId: string) =>
        personSeat(personId, botId),
      downloadFile: async () => {
        throw error;
      },
    } as unknown as ComputerGateway;
    const response = await appFor(gateway).request(
      "http://openbot.test/bot-17/files/download?path=x",
    );

    expect(response.status).toBe(status);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: error.message });
    if (error instanceof ActionRefusedError) {
      expect(body).toMatchObject({ rule: error.rule });
    }
  });

  /*
   * WP-0.4 补的五条：下载路由上「谁也不许顺手改」的几件事，逐条钉住。
   *
   * 这里没有新行为，全是既有行为的护栏。`..` 的处置权在员工那台电脑的工作区根上，路由做一次归一化那道
   * 墙就等不到它了；「没有这个员工」和「这个员工不归你」答得逐字一样，这条路由才探不出部署里有谁；被
   * 挡下、太大、没有文件都不带附件头，「回来的是附件、不是这一页上渲染的一页 HTML」才只可能出在真给出
   * 字节的那一条；点取消要能传到电脑那侧，否则浏览器早不读了、电脑还在传；中文文件名的往返靠 RFC 5987
   * 那一段，退回去就是问号或下划线。
   */

  test.each([
    ["写在前面", "../secrets.txt", "../secrets.txt"],
    ["夹在中间", "reports/../../secrets.txt", "reports/../../secrets.txt"],
    ["点着写的", "./../notes.md", "./../notes.md"],
    ["转义过的", "../notes.md", "%2e%2e%2fnotes.md"],
  ])(
    // 路由不做路径判断：归一化、拒绝、以哪个根为准，都是那台电脑的工作区决定的。这里先把 `..` 抹平或
    // 折掉，工作区的那道墙就再也收不到它，而这一条链接正是把它送过去的唯一一条路。
    "把%s的 `..` 原样交给电脑：%i",
    async (_name, path, wire) => {
      const { gateway, calls } = gatewayThatReturns(
        "x",
        Uint8Array.from([1]),
      );
      const response = await appFor(gateway).request(
        `http://openbot.test/bot-17/files/download?path=${wire}`,
      );

      expect(response.status).toBe(200);
      expect(calls).toEqual([{ botId: "bot-17", actorId: "user-1", path }]);
    },
  );

  test("探不出部署里有谁：别人的员工和不归这边的浏览器员工答得逐字一样", async () => {
    const { gateway, calls } = gatewayThatReturns("x", Uint8Array.from([1]));
    const notYours = await appFor(gateway, async () => false).request(
      "http://openbot.test/somebody-elses-bot/files/download?path=x",
    );
    // 一个人的浏览器只答它自己的那三条读，下载不在其中：它走的是另一条 404 分支，不是 `canUseBot`。
    const browserBot = await appFor(gateway).request(
      `http://openbot.test/person-${"a".repeat(32)}/files/download?path=x`,
    );

    expect(notYours.status).toBe(404);
    expect(browserBot.status).toBe(404);
    // 逐字相等：两条分支除了这句话没有别的，长度、键、顺序都一样，探的人分不出是哪种。
    expect(await browserBot.text()).toBe(await notYours.text());
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["被边界挡下", new WorkspaceRefusedError("Outside."), 403],
    ["文件太大", new WorkspaceTooLargeError("Too large."), 413],
    ["没有这个文件", new WorkspaceNotFoundError("No such file."), 404],
  ])(
    // 「恒为不透明附件」说的是成功那一条；挡下来的是 JSON，一个附件头也不带，否则一个 413 就能把 HTML
    // 当成文件在这一页上渲染出来。
    "%s（%i）不带附件头",
    async (_name, error, status) => {
      const gateway = {
        seatFor: async (botId: string, personId: string) =>
          personSeat(personId, botId),
        downloadFile: async () => {
          throw error;
        },
      } as unknown as ComputerGateway;
      const response = await appFor(gateway).request(
        "http://openbot.test/bot-17/files/download?path=x",
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(
        (response.headers.get("content-type") ?? "").startsWith(
          "application/json",
        ),
      ).toBe(true);
    },
  );

  test("点取消传得到电脑那侧：请求的 signal 是 downloadFile 的第 4 个参数", async () => {
    const seen: { path?: string; signal?: unknown }[] = [];
    const gateway = {
      seatFor: async (botId: string, personId: string) =>
        personSeat(personId, botId),
      downloadFile: async (
        _seat: unknown,
        _actor: unknown,
        input: { path: string },
        signal?: unknown,
      ) => {
        seen.push({ path: input.path, signal });
        return { body: Uint8Array.from([1]), bytes: 1, name: "x" };
      },
    } as unknown as ComputerGateway;
    const controller = new AbortController();
    const response = await appFor(gateway).request(
      "http://openbot.test/bot-17/files/download?path=x",
      { signal: controller.signal },
    );

    expect(response.status).toBe(200);
    // 同一个对象，不是复制出来的：取消要一路取消到那台电脑上的读，中途换一个 signal 就断在半路。
    expect(seen[0]?.signal).toBe(controller.signal);
  });

  test("中文文件名走得回来：UTF-8 那一段解码逐字相等", async () => {
    for (const name of ["季度报告.pdf", "报告(1).md", "a b·c.txt"]) {
      const { gateway } = gatewayThatReturns(name, Uint8Array.from([1]));
      const response = await appFor(gateway).request(
        "http://openbot.test/bot-17/files/download?path=x",
      );
      const header = response.headers.get("content-disposition") ?? "";
      const encoded = /filename\*=UTF-8''([^;]*)$/.exec(header)?.[1];

      expect(encoded).toBeDefined();
      expect(decodeURIComponent(encoded ?? "")).toBe(name);
      // encodeURIComponent 放过的 () ' * 也按 RFC 5987 转义掉：留着它们，有的浏览器就在这里截参数。
      expect(/[!'()*]/.test(encoded ?? "")).toBe(false);
      // 回退的那份只留 ASCII（非 ASCII 一律下划线），文件名才在只认旧写法的浏览器里也不变成问号。
      expect(/filename="([^"]*)"/.exec(header)?.[1]).toBe(
        [...name]
          .map((character) =>
            character >= " " && character <= "~" ? character : "_",
          )
          .join(""),
      );
    }

    // 整串逐字钉住一条，改格式的人一眼看得见自己动了哪一段。
    const { gateway } = gatewayThatReturns(
      "季度报告.pdf",
      Uint8Array.from([1]),
    );
    const response = await appFor(gateway).request(
      "http://openbot.test/bot-17/files/download?path=x",
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="____.pdf"; filename*=UTF-8''${encodeURIComponent(
        "季度报告.pdf",
      )}`,
    );
  });
});
