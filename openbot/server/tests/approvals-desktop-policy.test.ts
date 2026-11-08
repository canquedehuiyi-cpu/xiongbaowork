import { describe, expect, test } from "bun:test";
import {
  DESKTOP_WINDOW_UNKNOWN,
  desktopFloor,
} from "../src/approvals/desktop-policy";
import { decideAction } from "../src/approvals/policy";
import type {
  ApprovalCandidate,
  ApprovalRule,
  ApprovalTeamRule,
} from "../src/approvals/types";

const candidate = (
  over: Partial<ApprovalCandidate> = {},
): ApprovalCandidate => ({
  actorId: "owner",
  botId: "bot",
  toolRef: "computer_desktop_snapshot",
  effect: "read",
  scope: "desktop/chrome",
  args: { windowId: "w1" },
  ...over,
});
const rule = (
  behaviour: ApprovalRule["behaviour"],
  over: Partial<ApprovalRule> = {},
): ApprovalRule => ({
  id: `rule-${behaviour}`,
  ownerUserId: "owner",
  botId: "*",
  toolRef: "*",
  effect: "*",
  scope: "*",
  behaviour,
  revokedAt: null,
  createdAt: new Date(),
  ...over,
});
const team = (
  behaviour: ApprovalRule["behaviour"],
  over: Partial<ApprovalTeamRule> = {},
): ApprovalTeamRule => {
  const { ownerUserId: _owner, ...rest } = rule(
    behaviour,
    over as ApprovalRule,
  );
  return { ...rest, id: `team-${behaviour}`, createdBy: "admin", ...over };
};
const base = {
  team: [] as ApprovalTeamRule[],
  personal: [] as ApprovalRule[],
  customRulesEnabled: true,
  autoReview: false,
  askBeforeChanges: false,
};

describe("desktop window floor", () => {
  test("a plain window title is read without asking", async () => {
    const out = await decideAction({
      ...base,
      candidate: candidate({
        subject: { runner: true, desktop: { title: "无标题 - 记事本" } },
      }),
    });
    expect(out.behaviour).toBe("allow");
  });

  test("a sensitive title asks, naming the window and the word", async () => {
    const out = await decideAction({
      ...base,
      candidate: candidate({
        subject: {
          runner: true,
          desktop: { title: "招商银行 - Google Chrome", sensitiveWord: "银行" },
        },
      }),
    });
    expect(out).toMatchObject({
      behaviour: "ask",
      source: "desktop_window",
      reason:
        "窗口「招商银行 - Google Chrome」的标题含「银行」，读取它之前需要你批准。",
    });
  });

  test("the floor only raises: an allow rule for the tool still asks", async () => {
    const out = await decideAction({
      ...base,
      personal: [rule("allow", { toolRef: "computer_desktop_snapshot" })],
      candidate: candidate({
        subject: {
          runner: true,
          desktop: { title: "招商银行", sensitiveWord: "银行" },
        },
      }),
    });
    expect(out).toMatchObject({ behaviour: "ask", source: "desktop_window" });
  });

  test("a disabled tool is still refused outright", async () => {
    const out = await decideAction({
      ...base,
      team: [team("deny", { toolRef: "computer_desktop_snapshot" })],
      candidate: candidate({
        subject: {
          runner: true,
          desktop: { title: "招商银行", sensitiveWord: "银行" },
        },
      }),
    });
    expect(out.behaviour).toBe("deny");
  });

  test("no window information from the call site asks", async () => {
    const out = await decideAction({
      ...base,
      candidate: candidate({ subject: { runner: true } }),
    });
    expect(out).toMatchObject({
      behaviour: "ask",
      source: "desktop_window",
      reason: DESKTOP_WINDOW_UNKNOWN,
    });
  });

  test("a title in the model's args is ignored", async () => {
    const out = await decideAction({
      ...base,
      candidate: candidate({
        args: {
          title: "招商银行",
          sensitiveWord: "银行",
          desktop: { sensitiveWord: "银行" },
        },
        subject: { runner: true, desktop: { title: "无标题 - 记事本" } },
      }),
    });
    expect(out.behaviour).toBe("allow");
    expect(
      desktopFloor(
        candidate({
          args: { sensitiveWord: "银行" },
          subject: { runner: true, desktop: { title: "记事本" } },
        }),
      ),
    ).toBeUndefined();
  });

  test("listing windows never asks", async () => {
    const out = await decideAction({
      ...base,
      candidate: candidate({
        toolRef: "computer_desktop_windows",
        subject: { runner: true },
      }),
    });
    expect(out.behaviour).toBe("allow");
  });

  test("the team's host-command cap does not touch desktop reads", async () => {
    const out = await decideAction({
      ...base,
      hostCommandsCap: "never",
      candidate: candidate({
        subject: { runner: true, desktop: { title: "无标题 - 记事本" } },
      }),
    });
    expect(out.behaviour).toBe("allow");
  });
});
