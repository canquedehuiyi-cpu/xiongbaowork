import { describe, expect, test } from "bun:test";
import { offersStandingRule } from "@openbot/shared/standing-rule";
import {
  DESKTOP_SESSION_REASON,
  desktopActionReason,
} from "../src/approvals/desktop-policy";
import { decideAction, refusedOutright } from "../src/approvals/policy";
import type {
  ApprovalCandidate,
  ApprovalPolicyOutcome,
  ApprovalRule,
  ApprovalSubject,
} from "../src/approvals/types";

/**
 * Per-action approval for desktop writes (plan Task 17, design decisions 6, 10, 11 and 13): the
 * sensitive window, reading the clipboard, an unknown control, a control whose name is an action
 * word, a submit or close key, and a newline into a single-line field each ask, once only, through
 * the real `decideAction`. And the team's host-command cap covers desktop writes.
 */

const OWNER = "owner";

const write = (
  over: Partial<NonNullable<ApprovalSubject["desktopWrite"]>> = {},
): NonNullable<ApprovalSubject["desktopWrite"]> => ({
  session: "active",
  action: "click",
  title: "无标题 - 记事本",
  process: "notepad",
  control: { type: "Button", name: "确定" },
  ...over,
});
const toolOf: Record<string, string> = {
  click: "computer_desktop_click",
  type: "computer_desktop_type",
  key: "computer_desktop_key",
  focus: "computer_desktop_focus",
  launch: "computer_desktop_launch",
  clipboard_read: "computer_desktop_clipboard_read",
  clipboard_write: "computer_desktop_clipboard_write",
};
const candidate = (
  over: Partial<NonNullable<ApprovalSubject["desktopWrite"]>> = {},
): ApprovalCandidate => {
  const desktopWrite = write(over);
  return {
    actorId: OWNER,
    botId: "bot",
    toolRef: toolOf[desktopWrite.action] ?? "computer_desktop_click",
    effect: "write",
    scope: "desktop/notepad",
    args: { windowId: "a0123456789abcdef", ref: "abc123-1:0" },
    subject: { runner: true, desktopWrite },
  };
};
const rule = (
  behaviour: ApprovalRule["behaviour"],
  over: Partial<ApprovalRule> = {},
): ApprovalRule => ({
  id: `rule-${behaviour}`,
  ownerUserId: OWNER,
  botId: "*",
  toolRef: "*",
  effect: "*",
  scope: "*",
  behaviour,
  revokedAt: null,
  createdAt: new Date(),
  ...over,
});
const base = {
  team: [],
  personal: [] as ApprovalRule[],
  customRulesEnabled: true,
  autoReview: false,
  askBeforeChanges: true,
};
const SESSION_ALLOW: ApprovalPolicyOutcome = {
  behaviour: "allow",
  source: "desktop_session",
  reason: "桌面会话进行中。",
};

describe("desktop per-action approval", () => {
  test("clicking 发送 asks once only, naming window and control", async () => {
    const out = await decideAction({
      ...base,
      candidate: candidate({
        title: "微信",
        control: { type: "Button", name: "发送(S)" },
      }),
    });
    expect(out).toEqual({
      behaviour: "ask",
      source: "desktop_action",
      reason: "在窗口「微信」里点击「发送(S)」：控件名含「发送」，需要你批准。",
    });
    expect(offersStandingRule({ policy: out })).toBeFalse();
    const exact = await decideAction({
      ...base,
      candidate: candidate({
        title: "微信",
        control: { type: "Button", name: "发送" },
      }),
    });
    expect(exact.reason).toBe(
      "在窗口「微信」里点击「发送」：控件名含「发送」，需要你批准。",
    );
    // An allow rule for the tool does not skip it; a rule that asks is restated as this floor.
    const allowed = await decideAction({
      ...base,
      personal: [rule("allow", { toolRef: "computer_desktop_click" })],
      candidate: candidate({
        title: "微信",
        control: { type: "Button", name: "发送" },
      }),
    });
    expect(allowed).toMatchObject({
      behaviour: "ask",
      source: "desktop_action",
      reason: exact.reason,
    });
    const asked = await decideAction({
      ...base,
      personal: [rule("ask", { toolRef: "computer_desktop_click" })],
      candidate: candidate({
        title: "微信",
        control: { type: "Button", name: "发送" },
      }),
    });
    expect(asked.source).toBe("desktop_action");
    expect(asked.reason.startsWith(exact.reason)).toBeTrue();
    // An ordinary control in a session does not ask.
    expect(await decideAction({ ...base, candidate: candidate() })).toEqual(
      SESSION_ALLOW,
    );
  });

  test("every write in a window titled 招商银行 asks, even in a session", async () => {
    const verbs: Array<[string, string]> = [
      ["click", "点击"],
      ["type", "输入文字"],
      ["key", "按键"],
      ["focus", "切换窗口"],
      ["launch", "启动程序"],
      ["clipboard_write", "写入剪贴板"],
    ];
    for (const [action, verb] of verbs) {
      const out = await decideAction({
        ...base,
        candidate: candidate({
          action: action as NonNullable<
            ApprovalSubject["desktopWrite"]
          >["action"],
          title: "招商银行",
          keys: action === "key" ? "ctrl+s" : undefined,
        }),
      });
      expect({ action, out }).toEqual({
        action,
        out: {
          behaviour: "ask",
          source: "desktop_action",
          reason: `窗口「招商银行」的标题含「银行」，在里面${verb}需要你批准。`,
        },
      });
    }
    // Window words match by substring as well as by whole word: the stricter reading wins.
    for (const [title, word] of [
      ["PayPal - Checkout", "paypal"],
      ["1Password", "password"],
      ["Passwords", "password"],
      ["Chase Online Banking", "bank"],
      ["Online-Banking", "bank"],
      ["Embankment notes", "bank"],
    ])
      expect({
        title,
        out: await decideAction({ ...base, candidate: candidate({ title }) }),
      }).toEqual({
        title,
        out: {
          behaviour: "ask",
          source: "desktop_action",
          reason: `窗口「${title}」的标题含「${word}」，在里面点击需要你批准。`,
        },
      });
  });

  test("reading the clipboard always asks", async () => {
    for (const askBeforeChanges of [true, false]) {
      const out = await decideAction({
        ...base,
        askBeforeChanges,
        personal: [rule("allow")],
        candidate: candidate({
          action: "clipboard_read",
          title: undefined,
          control: undefined,
        }),
      });
      // The allow rule that matched is kept on the outcome; it does not let the read through.
      expect(out).toEqual({
        behaviour: "ask",
        source: "desktop_action",
        ruleId: "rule-allow",
        reason:
          "读取你的剪贴板（里面可能有刚复制的密码或验证码），需要你批准。",
      });
    }
    // Writing it, outside a sensitive window, does not.
    expect(
      await decideAction({
        ...base,
        candidate: candidate({ action: "clipboard_write", control: undefined }),
      }),
    ).toEqual(SESSION_ALLOW);
  });

  test("an unknown control asks", async () => {
    for (const action of ["click", "type"] as const) {
      const out = await decideAction({
        ...base,
        candidate: candidate({ action, control: null }),
      });
      expect({ action, out }).toEqual({
        action,
        out: {
          behaviour: "ask",
          source: "desktop_action",
          reason:
            "没能确认要操作的控件，在窗口「无标题 - 记事本」里执行前需要你批准。",
        },
      });
    }
  });

  test("a write in a window whose title is unknown asks as an unknown control", async () => {
    for (const action of ["click", "type", "key", "focus"] as const) {
      const out = await decideAction({
        ...base,
        candidate: candidate({
          action,
          title: undefined,
          keys: action === "key" ? "ctrl+s" : undefined,
        }),
      });
      expect({ action, out }).toEqual({
        action,
        out: {
          behaviour: "ask",
          source: "desktop_action",
          reason: "没能确认要操作的控件，在窗口「」里执行前需要你批准。",
        },
      });
    }
    // Launching a program and writing the clipboard have no window to confirm.
    for (const action of ["launch", "clipboard_write"] as const)
      expect({
        action,
        out: await decideAction({
          ...base,
          candidate: candidate({
            action,
            title: undefined,
            control: undefined,
          }),
        }),
      }).toEqual({ action, out: SESSION_ALLOW });
  });

  test("enter asks; shift+enter does not", async () => {
    for (const keys of ["enter", "Enter", "ctrl+enter", "cmd+return"]) {
      const out = await decideAction({
        ...base,
        candidate: candidate({
          action: "key",
          title: "微信",
          control: undefined,
          keys,
        }),
      });
      expect({ keys, out }).toEqual({
        keys,
        out: {
          behaviour: "ask",
          source: "desktop_action",
          reason: `在窗口「微信」里按 ${keys}，可能会把内容提交或发送出去，需要你批准。`,
        },
      });
    }
    for (const keys of ["shift+enter", "ctrl+s", "tab"])
      expect({
        keys,
        out: await decideAction({
          ...base,
          candidate: candidate({
            action: "key",
            title: "微信",
            control: undefined,
            keys,
          }),
        }),
      }).toEqual({ keys, out: SESSION_ALLOW });
  });

  test("alt+f4 asks as closing a program", async () => {
    for (const keys of ["alt+f4", "cmd+q", "ctrl+w"]) {
      const out = await decideAction({
        ...base,
        candidate: candidate({
          action: "key",
          title: "无标题 - 记事本",
          control: undefined,
          keys,
        }),
      });
      expect({ keys, out }).toEqual({
        keys,
        out: {
          behaviour: "ask",
          source: "desktop_action",
          reason: `在窗口「无标题 - 记事本」里按 ${keys}，会关闭程序，需要你批准。`,
        },
      });
    }
  });

  test("keys the gateway should have refused, or cannot read, still ask", async () => {
    for (const keys of [
      "win+r",
      "win+tab",
      "ctrl+alt+shift+cmd+x",
      "f13",
      undefined,
    ]) {
      const out = await decideAction({
        ...base,
        candidate: candidate({ action: "key", control: undefined, keys }),
      });
      expect({ keys, out }).toEqual({
        keys,
        out: {
          behaviour: "ask",
          source: "desktop_action",
          reason: "这个按键可能会触发系统操作，需要你先确认。",
        },
      });
    }
  });

  test("a newline into a single-line field asks as a submit", async () => {
    const out = await decideAction({
      ...base,
      candidate: candidate({
        action: "type",
        title: "微信",
        control: { type: "Edit", name: "搜索" },
        newlineInSingleLine: true,
      }),
    });
    expect(out).toEqual({
      behaviour: "ask",
      source: "desktop_action",
      reason:
        "往窗口「微信」的单行输入框「搜索」里输入带换行的文字，相当于提交，需要你批准。",
    });
    expect(
      await decideAction({
        ...base,
        candidate: candidate({
          action: "type",
          title: "微信",
          control: { type: "Edit", name: "搜索" },
          newlineInSingleLine: false,
        }),
      }),
    ).toEqual(SESSION_ALLOW);
  });

  test("with no session and a word hit there is one card, source desktop_action, both reasons", async () => {
    const action =
      "在窗口「微信」里点击「发送」：控件名含「发送」，需要你批准。";
    expect(
      desktopActionReason(
        candidate({ title: "微信", control: { type: "Button", name: "发送" } }),
        ["发送"],
      ),
    ).toBe(action);
    const none = {
      session: "none" as const,
      title: "微信",
      control: { type: "Button", name: "发送" },
    };
    // With the "ask before changes" default off nothing else asks: the card is exactly both reasons.
    expect(
      await decideAction({
        ...base,
        askBeforeChanges: false,
        candidate: candidate(none),
      }),
    ).toEqual({
      behaviour: "ask",
      source: "desktop_action",
      reason: `${DESKTOP_SESSION_REASON}${action}`,
    });
    // With it on, the default's own reason is kept after both, as for every once-only floor.
    const asked = await decideAction({ ...base, candidate: candidate(none) });
    expect(asked).toMatchObject({ behaviour: "ask", source: "desktop_action" });
    expect(asked.reason.startsWith(`${DESKTOP_SESSION_REASON}${action}`)).toBe(
      true,
    );
    expect(offersStandingRule({ policy: asked })).toBeFalse();
    // No word hit and no session: the session card alone.
    expect(
      await decideAction({
        ...base,
        askBeforeChanges: false,
        candidate: candidate({ session: "none" }),
      }),
    ).toEqual({
      behaviour: "ask",
      source: "desktop_session",
      reason: DESKTOP_SESSION_REASON,
    });
  });

  test("the team cap: never refuses every desktop write outright, ask asks", async () => {
    for (const action of Object.keys(toolOf)) {
      const c = candidate({
        action: action as NonNullable<
          ApprovalSubject["desktopWrite"]
        >["action"],
      });
      const refused = await decideAction({
        ...base,
        hostCommandsCap: "never",
        candidate: c,
      });
      expect({
        action,
        behaviour: refused.behaviour,
        source: refused.source,
      }).toEqual({
        action,
        behaviour: "deny",
        source: "host_command_cap",
      });
      expect(
        refusedOutright({ ...base, hostCommandsCap: "never", candidate: c })
          ?.behaviour,
      ).toBe("deny");
      // Whatever the gateway put in `runner`, a desktop write is on a paired computer.
      const unmarked = {
        ...c,
        subject: { desktopWrite: c.subject?.desktopWrite },
      };
      expect(
        (
          await decideAction({
            ...base,
            hostCommandsCap: "never",
            candidate: unmarked,
          })
        ).behaviour,
      ).toBe("deny");
    }
    // `ask`: in a session an ordinary write that would go through asks.
    const asked = await decideAction({
      ...base,
      hostCommandsCap: "ask",
      candidate: candidate(),
    });
    expect(asked).toMatchObject({
      behaviour: "ask",
      source: "host_command_cap",
    });
    // With no session the session card still says what opening one means.
    const none = await decideAction({
      ...base,
      askBeforeChanges: false,
      hostCommandsCap: "ask",
      candidate: candidate({ session: "none" }),
    });
    expect(none).toEqual({
      behaviour: "ask",
      source: "desktop_session",
      reason: DESKTOP_SESSION_REASON,
    });
    // `allow` changes nothing.
    expect(
      await decideAction({
        ...base,
        hostCommandsCap: "allow",
        candidate: candidate(),
      }),
    ).toEqual(SESSION_ALLOW);
  });

  test("a team word list replaces the default", async () => {
    const archive = await decideAction({
      ...base,
      desktopActionWords: ["归档"],
      candidate: candidate({
        title: "邮件",
        control: { type: "Button", name: "归档" },
      }),
    });
    expect(archive).toEqual({
      behaviour: "ask",
      source: "desktop_action",
      reason: "在窗口「邮件」里点击「归档」：控件名含「归档」，需要你批准。",
    });
    expect(
      await decideAction({
        ...base,
        desktopActionWords: ["归档"],
        candidate: candidate({
          title: "邮件",
          control: { type: "Button", name: "发送" },
        }),
      }),
    ).toEqual(SESSION_ALLOW);
    // The window words, the clipboard and the keys are not the team's list: they still ask.
    expect(
      (
        await decideAction({
          ...base,
          desktopActionWords: ["归档"],
          candidate: candidate({
            action: "key",
            control: undefined,
            keys: "enter",
          }),
        })
      ).source,
    ).toBe("desktop_action");
  });

  test("a team word list of blank words is no list: the default applies", async () => {
    for (const desktopActionWords of [[], ["", "  "]]) {
      const out = await decideAction({
        ...base,
        desktopActionWords,
        candidate: candidate({
          title: "微信",
          control: { type: "Button", name: "发送" },
        }),
      });
      expect({ desktopActionWords, source: out.source }).toEqual({
        desktopActionWords,
        source: "desktop_action",
      });
    }
    // A blank word next to a real one is dropped, never matched against everything.
    expect(
      await decideAction({
        ...base,
        desktopActionWords: ["归档", " "],
        candidate: candidate({
          title: "邮件",
          control: { type: "Button", name: "发送" },
        }),
      }),
    ).toEqual(SESSION_ALLOW);
  });

  test("both desktop sources are once only", () => {
    expect(offersStandingRule({ policy: { source: "desktop_session" } })).toBe(
      false,
    );
    expect(offersStandingRule({ policy: { source: "desktop_action" } })).toBe(
      false,
    );
  });

  test("a desktop read is not a desktop write: no action floor, no cap", async () => {
    const read: ApprovalCandidate = {
      actorId: OWNER,
      botId: "bot",
      toolRef: "computer_desktop_windows",
      effect: "read",
      scope: "desktop",
      args: {},
      subject: { runner: true },
    };
    const out = await decideAction({
      ...base,
      hostCommandsCap: "never",
      candidate: read,
    });
    expect(out.behaviour).not.toBe("deny");
    expect(out.source).not.toBe("desktop_action");
  });
});
