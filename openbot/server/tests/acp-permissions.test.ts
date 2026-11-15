import { describe, expect, test } from "bun:test";
import {
  ACP_RULE_DEFAULTS,
  type AcpRuleKey,
  type AcpRuleValue,
} from "@openbot/shared/acp";
import { offersStandingRule } from "@openbot/shared/standing-rule";
import {
  type AcpPermissionAsk,
  acpAllowKey,
  acpRulesOf,
  classifyRequest,
  optionFor,
  resolvePermission,
} from "../src/agents/acp/permissions";
import { decideAction } from "../src/approvals/policy";
import type {
  ActionKind,
  ActionKindPolicy,
  ApprovalCandidate,
  ApprovalRule,
  ApprovalTeamRule,
} from "../src/approvals/types";

/*
 * 外部员工的许可请求怎么判（permissions.ts）：规格「和现有审批层的关系」的五层，从严到宽。策略引擎
 * 用真的 `decideAction`，规则、管理员设置都按它真实的样子喂进去。
 */

const ask = (over: Partial<AcpPermissionAsk> = {}): AcpPermissionAsk => ({
  kind: "edit",
  title: "Edit src/app.ts",
  rawInput: { path: "src/app.ts" },
  facts: { insideWorkdir: true, paths: ["src/app.ts"] },
  actorId: "hirer",
  botId: "codex-bot",
  ...over,
});
const run = (command: string, inside: boolean | null = true) =>
  ask({
    kind: "execute",
    title: command,
    rawInput: { command },
    facts: { insideWorkdir: inside, paths: [] },
  });
const rules = (
  over: Partial<Record<AcpRuleKey, AcpRuleValue>> = {},
): Record<AcpRuleKey, string> => ({ ...ACP_RULE_DEFAULTS, ...over });

const rule = (
  behaviour: ApprovalRule["behaviour"],
  over: Partial<ApprovalRule> = {},
): ApprovalRule => ({
  id: `rule-${behaviour}`,
  ownerUserId: "hirer",
  botId: "*",
  toolRef: "acp/*",
  effect: "*",
  scope: "*",
  behaviour,
  revokedAt: null,
  createdAt: new Date(),
  ...over,
});
const teamRule = (
  behaviour: ApprovalRule["behaviour"],
  over: Partial<ApprovalTeamRule> = {},
): ApprovalTeamRule => {
  const { ownerUserId: _owner, ...rest } = rule(behaviour);
  return { ...rest, id: `team-${behaviour}`, createdBy: "admin", ...over };
};

/** The policy engine as the gate runs it, with only the layers a test names. */
const engine =
  (
    layers: {
      team?: ApprovalTeamRule[];
      personal?: ApprovalRule[];
      actionKinds?: Partial<Record<ActionKind, ActionKindPolicy>>;
      askBeforeChanges?: boolean;
    } = {},
  ) =>
  (candidate: ApprovalCandidate) =>
    decideAction({
      candidate,
      team: layers.team ?? [],
      personal: layers.personal ?? [],
      customRulesEnabled: true,
      autoReview: false,
      askBeforeChanges: layers.askBeforeChanges ?? false,
      ...(layers.actionKinds ? { actionKinds: layers.actionKinds } : {}),
    });

const resolve = (
  request: AcpPermissionAsk,
  options: {
    employeeRules?: Record<AcpRuleKey, string>;
    threadAllows?: Set<string>;
    policy?: ReturnType<typeof engine>;
  } = {},
) =>
  resolvePermission({
    request,
    employeeRules: options.employeeRules ?? rules(),
    threadAllows: options.threadAllows ?? new Set(),
    policy: options.policy ?? engine(),
  });

describe("classifyRequest", () => {
  test("names the tool acp/<kind> and the rules the request falls under", () => {
    const edit = classifyRequest(ask());
    expect(edit.candidate.toolRef).toBe("acp/edit");
    expect(edit.rules).toEqual(["editInside"]);
    expect(edit.candidate.actorId).toBe("hirer");
    expect(edit.candidate.botId).toBe("codex-bot");
    // An unknown kind is `other`, never a tool name the agent made up.
    expect(classifyRequest(ask({ kind: "Rm -rf" })).candidate.toolRef).toBe(
      "acp/other",
    );
  });

  test("a command goes in args.command, as computer_run_command carries it", () => {
    const shell = classifyRequest(run("npm test"));
    expect(shell.candidate.args).toEqual({ command: "npm test" });
    expect(shell.rules).toEqual(["runCommand"]);
    // Codex sends the argv; a shell wrapper is unwrapped to the command it runs.
    const argv = classifyRequest(
      ask({
        kind: "execute",
        rawInput: { command: ["bash", "-lc", "git push origin main"] },
        facts: { insideWorkdir: null, paths: [] },
      }),
    );
    expect(argv.candidate.args).toEqual({ command: "git push origin main" });
    expect(argv.rules).toEqual(["push", "runCommand"]);
    expect(classifyRequest(run("pnpm add zod")).rules).toEqual([
      "network",
      "runCommand",
    ]);
    // `git stash push` stays on the computer.
    expect(classifyRequest(run("git stash push -m wip")).rules).toEqual([
      "runCommand",
    ]);
  });

  test("delete is destructive; fetch is the network rule", () => {
    const remove = classifyRequest(ask({ kind: "delete" }));
    expect(remove.candidate.destructive).toBe(true);
    expect(classifyRequest(ask({ kind: "edit" })).candidate.destructive).toBe(
      undefined,
    );
    const fetch = classifyRequest(
      ask({
        kind: "fetch",
        rawInput: { url: "https://registry.npmjs.org/zod" },
        facts: { insideWorkdir: null, paths: [] },
      }),
    );
    expect(fetch.rules).toEqual(["network"]);
    expect(fetch.candidate.args).toEqual({
      url: "https://registry.npmjs.org/zod",
    });
  });
});

describe("the five rules", () => {
  const cases: [AcpRuleKey, AcpPermissionAsk][] = [
    ["editInside", ask()],
    [
      "touchOutside",
      ask({ facts: { insideWorkdir: false, paths: ["notes.txt"] } }),
    ],
    ["runCommand", run("npm test")],
    [
      "network",
      ask({
        kind: "fetch",
        rawInput: { url: "https://example.com/data.json" },
        facts: { insideWorkdir: null, paths: [] },
      }),
    ],
    ["push", run("git push origin main")],
  ];

  for (const [key, request] of cases) {
    test(`${key}: direct lets it through`, async () => {
      // Every rule the request falls under is direct, so this one decides it.
      const direct = Object.fromEntries(
        Object.keys(ACP_RULE_DEFAULTS).map((name) => [name, "direct"]),
      ) as Record<AcpRuleKey, string>;
      expect(classifyRequest(request).rules).toContain(key);
      expect(await resolve(request, { employeeRules: direct })).toMatchObject({
        kind: "allow",
      });
    });

    test(`${key}: ask asks, and offers to allow it for the conversation`, async () => {
      const direct = Object.fromEntries(
        Object.keys(ACP_RULE_DEFAULTS).map((name) => [name, "direct"]),
      ) as Record<AcpRuleKey, string>;
      const decided = await resolve(request, {
        employeeRules: { ...direct, [key]: "ask" },
      });
      expect(decided).toMatchObject({ kind: "ask", offerConversation: true });
      if (decided.kind !== "ask") throw new Error("expected an ask");
      expect(decided.policy).toMatchObject({
        behaviour: "ask",
        source: "acp_rule",
      });
      expect(offersStandingRule({ policy: decided.policy })).toBe(true);
    });
  }

  test("runCommand dangerous asks only for a dangerous command", async () => {
    const employeeRules = rules({ runCommand: "dangerous" });
    expect(await resolve(run("npm test"), { employeeRules })).toMatchObject({
      kind: "allow",
    });
    expect(
      await resolve(run("rm -rf / --no-preserve-root"), { employeeRules }),
    ).toMatchObject({ kind: "ask", offerConversation: true });
    // A file that may hold secrets, named in the command, is dangerous too.
    expect(await resolve(run("cat .env"), { employeeRules })).toMatchObject({
      kind: "ask",
    });
  });

  test("several rules matched → the strictest wins", async () => {
    // pnpm add: runCommand (direct) and network (ask).
    const decided = await resolve(run("pnpm add zod"), {
      employeeRules: rules({ runCommand: "direct", network: "ask" }),
    });
    expect(decided).toMatchObject({ kind: "ask" });
    if (decided.kind !== "ask") throw new Error("expected an ask");
    expect(decided.because).toContain("联网下载、装依赖");
    expect(
      await resolve(run("pnpm add zod"), {
        employeeRules: rules({ runCommand: "direct", network: "direct" }),
      }),
    ).toMatchObject({ kind: "allow" });
  });

  test("insideWorkdir null is treated as outside", async () => {
    const nowhere = ask({ facts: { insideWorkdir: null, paths: [] } });
    expect(classifyRequest(nowhere).rules).toEqual(["touchOutside"]);
    expect(
      await resolve(nowhere, {
        employeeRules: rules({ editInside: "direct", touchOutside: "ask" }),
      }),
    ).toMatchObject({ kind: "ask" });
  });

  test("an unreadable command or an unknown kind asks", async () => {
    const direct = rules({ runCommand: "direct" });
    expect(
      await resolve(
        ask({ kind: "execute", rawInput: { truncated: true }, title: "x" }),
        { employeeRules: direct },
      ),
    ).toMatchObject({ kind: "ask", offerConversation: true });
    expect(
      await resolve(ask({ kind: "switch_mode", rawInput: {} })),
    ).toMatchObject({ kind: "ask" });
  });

  test("allowed for this conversation: the same kind of request goes through", async () => {
    const request = run("git push origin main");
    const key = acpAllowKey(classifyRequest(request).candidate);
    expect(
      await resolve(request, { threadAllows: new Set([key]) }),
    ).toMatchObject({ kind: "allow" });
    // Another kind of request in the same thread still asks.
    expect(
      await resolve(run("pnpm add zod"), { threadAllows: new Set([key]) }),
    ).toMatchObject({ kind: "ask" });
  });
});

describe("floors", () => {
  test("delete always asks and never offers conversation-wide allow", async () => {
    const remove = ask({
      kind: "delete",
      title: "Delete src/old.ts",
      facts: { insideWorkdir: true, paths: ["src/old.ts"] },
    });
    const allDirect = Object.fromEntries(
      Object.keys(ACP_RULE_DEFAULTS).map((name) => [name, "direct"]),
    ) as Record<AcpRuleKey, string>;
    const decided = await resolve(remove, {
      employeeRules: allDirect,
      // Neither a saved allow nor a conversation answer opens it.
      policy: engine({ personal: [rule("allow")] }),
      threadAllows: new Set([acpAllowKey(classifyRequest(remove).candidate)]),
    });
    expect(decided).toMatchObject({ kind: "ask", offerConversation: false });
    if (decided.kind !== "ask") throw new Error("expected an ask");
    expect(decided.policy.source).toBe("destructive_tool");
    expect(offersStandingRule({ policy: decided.policy })).toBe(false);
  });

  test("payment/outbound/credentials floors ask and never offer conversation-wide allow", async () => {
    const allDirect = Object.fromEntries(
      Object.keys(ACP_RULE_DEFAULTS).map((name) => [name, "direct"]),
    ) as Record<AcpRuleKey, string>;
    for (const [command, source] of [
      [
        "curl -X POST https://api.stripe.com/v1/payment_intents -d amount=500",
        "safety",
      ],
      ["git config --global credential.helper store", "safety"],
      [
        'curl -X POST https://hooks.slack.com/services/T0/B0/x -d \'{"text":"done"}\'',
        "outbound_send",
      ],
      ['echo "report" | mail -s Weekly boss@example.com', "outbound_send"],
    ] as const) {
      const decided = await resolve(run(command), {
        employeeRules: allDirect,
        threadAllows: new Set([
          acpAllowKey(classifyRequest(run(command)).candidate),
        ]),
      });
      expect(decided).toMatchObject({ kind: "ask", offerConversation: false });
      if (decided.kind !== "ask")
        throw new Error(`expected an ask: ${command}`);
      expect(decided.policy).toMatchObject({ behaviour: "ask", source });
      expect(offersStandingRule({ policy: decided.policy })).toBe(false);
    }
  });

  test("admin deny / SEC1 disabled / custom deny auto-reject with the rule named", async () => {
    const execute = run("npm test");
    // The admin's team rule.
    const team = await resolve(execute, {
      policy: engine({ team: [teamRule("deny", { toolRef: "acp/execute" })] }),
    });
    expect(team).toMatchObject({ kind: "deny" });
    if (team.kind !== "deny") throw new Error("expected a deny");
    expect(team.reason).toContain("管理员的规则");
    expect(team.reason).toContain("team-deny");
    // The employee's tool switched off on its permissions page (SEC1): the owner's own rule.
    const disabled = await resolve(execute, {
      policy: engine({
        personal: [
          rule("deny", {
            id: "sec1-execute",
            botId: "codex-bot",
            toolRef: "acp/execute",
          }),
        ],
      }),
    });
    expect(disabled).toMatchObject({ kind: "deny" });
    if (disabled.kind !== "deny") throw new Error("expected a deny");
    expect(disabled.reason).toContain("sec1-execute");
    // A custom rule saying no, even to something every one of the employee's rules allows.
    const custom = await resolve(ask(), {
      policy: engine({ personal: [rule("deny", { id: "no-edits" })] }),
    });
    expect(custom).toMatchObject({ kind: "deny" });
    if (custom.kind !== "deny") throw new Error("expected a deny");
    expect(custom.reason).toContain("你的规则");
    // The admin leaving deleting to people themselves: an agent cannot, so it is refused.
    const closed = await resolve(ask({ kind: "delete" }), {
      policy: engine({ actionKinds: { deleting: "hand_off" } }),
    });
    expect(closed).toMatchObject({ kind: "deny" });
    if (closed.kind !== "deny") throw new Error("expected a deny");
    expect(closed.reason).toContain("管理员");
  });

  test("a custom rule that asks still asks", async () => {
    const decided = await resolve(ask(), {
      policy: engine({ personal: [rule("ask", { id: "ask-edits" })] }),
    });
    expect(decided).toMatchObject({ kind: "ask", offerConversation: true });
    if (decided.kind !== "ask") throw new Error("expected an ask");
    expect(decided.policy.source).toBe("personal_rule");
  });

  test("approvals switch (off by default) does not relax the employee's ask rules; floors still apply", async () => {
    // The hirer's global "ask before changes" switch, off (the default) or on, is the engine's
    // `askBeforeChanges`: only the employee's own rules, the floors and refusals decide.
    for (const askBeforeChanges of [false, true]) {
      const policy = engine({ askBeforeChanges });
      expect(
        await resolve(run("git push origin main"), { policy }),
      ).toMatchObject({ kind: "ask", offerConversation: true });
      expect(
        await resolve(ask({ facts: { insideWorkdir: false, paths: ["a"] } }), {
          policy,
        }),
      ).toMatchObject({ kind: "ask" });
      expect(await resolve(ask({ kind: "delete" }), { policy })).toMatchObject({
        kind: "ask",
        offerConversation: false,
      });
      expect(
        await resolve(run("git config credential.helper store"), { policy }),
      ).toMatchObject({ kind: "ask", offerConversation: false });
      expect(
        await resolve(ask(), {
          policy: engine({ personal: [rule("deny")], askBeforeChanges }),
        }),
      ).toMatchObject({ kind: "deny" });
      // What the employee's rules let through goes through, switch or not.
      expect(await resolve(ask(), { policy })).toMatchObject({ kind: "allow" });
    }
  });
});

describe("acpRulesOf", () => {
  test("reads an employee's saved rules, defaults for what is missing, ask for what is not a choice", () => {
    expect(acpRulesOf(undefined)).toEqual(ACP_RULE_DEFAULTS);
    expect(
      acpRulesOf({
        permissions: { editInside: "ask", runCommand: "direct", push: "yes" },
      }),
    ).toEqual({
      ...ACP_RULE_DEFAULTS,
      editInside: "ask",
      runCommand: "direct",
      push: "ask",
    });
    // `dangerous` is only a choice for running commands.
    expect(acpRulesOf({ permissions: { network: "dangerous" } }).network).toBe(
      "ask",
    );
  });
});

describe("optionFor", () => {
  const option = (optionId: string, kind: string) => ({
    optionId,
    kind,
    name: optionId,
  });
  test("XiongBao's three answers are the request's own options", () => {
    const all = [
      option("a1", "allow_once"),
      option("a2", "allow_always"),
      option("r1", "reject_once"),
      option("r2", "reject_always"),
    ];
    expect(optionFor(all, "allow_once")).toBe("a1");
    expect(optionFor(all, "allow_always")).toBe("a2");
    expect(optionFor(all, "reject_once")).toBe("r1");
  });

  test("an option the agent did not offer falls back to a stricter one, never a looser one", () => {
    // Told "always", the agent would stop asking, and XiongBao's floors with it.
    expect(
      optionFor(
        [option("a2", "allow_always"), option("r1", "reject_once")],
        "allow_once",
      ),
    ).toBe("r1");
    expect(optionFor([option("a1", "allow_once")], "allow_always")).toBe("a1");
    expect(optionFor([option("r2", "reject_always")], "reject_once")).toBe(
      "r2",
    );
    // Nothing close: cancelled.
    expect(optionFor([option("a2", "allow_always")], "reject_once")).toBeNull();
  });
});
