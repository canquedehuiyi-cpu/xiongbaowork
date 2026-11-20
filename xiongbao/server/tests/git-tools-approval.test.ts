import { expect, test } from "bun:test";
import {
  type ApprovedActionDependencies,
  createApprovedActionExecutor,
} from "../src/approvals/execute";
import { approvalAction } from "../src/approvals/types";

/*
 * 期 4 · Task 4.2：git 工具的审批。三个本地工具问的是电脑命令那一条，批准之后把工具原样再跑一遍；
 * `open_pull_request` 问的是连接器自己的调用，批准之后走连接器那条路径，参数一个不改。
 */

const PERSON = { kind: "person" as const, id: "" };

function continuation(toolName: string, args: Record<string, unknown>) {
  return {
    runId: "run",
    threadId: "thread",
    toolCallId: "call",
    toolName,
    args,
    messages: [],
    state: {},
    context: [],
    forwardedProps: {},
  };
}

function harness(overrides: Partial<ApprovedActionDependencies> = {}) {
  const connectorCalls: unknown[] = [];
  const nativeRuns: { name: string; args: unknown }[] = [];
  const deps = {
    sourceFor: async () => ({ channelId: "channel" }),
    gate: async () => undefined,
    computerTools: async () => [],
    hostTools: () => [],
    callTool: async (input: unknown) => {
      connectorCalls.push(input);
      return { text: "opened", isError: false };
    },
    answer: (result: { text: string }) => result.text,
    privateShareToolRef: "openbot/private_share",
    refusalMarker: "REFUSED:",
    personInitiator: PERSON,
    coordinationCall: async () => null,
    credentialActorFor: async () => "person",
    nativeTools: () =>
      ["git_branch", "git_commit", "git_diff_summary"].map((name) => ({
        name,
        ref: `bot/${name}`,
        description: "",
        parameters: undefined,
        execute: async (args: unknown) => {
          nativeRuns.push({ name, args });
          return `ran ${name}`;
        },
      })),
    ...overrides,
  } as ApprovedActionDependencies;
  return {
    execute: createApprovedActionExecutor(deps),
    connectorCalls,
    nativeRuns,
  };
}

test("an approved git_commit runs the tool again, not a connector call", async () => {
  const args = { repo: "app", paths: ["a.txt"], message: "改 a" };
  const action = approvalAction({
    actorId: "person",
    botId: "dev",
    toolRef: "computer_run_command",
    effect: "write",
    scope: "workspace",
    args: { command: "git add -- 'a.txt'" },
    target: { workspace: true },
    continuation: continuation("git_commit", args),
  });
  const { execute, connectorCalls, nativeRuns } = harness();
  await expect(execute(action)).resolves.toBe("ran git_commit");
  expect(nativeRuns).toEqual([{ name: "git_commit", args }]);
  expect(connectorCalls).toHaveLength(0);
});

test("a git tool that is no longer offered is refused, not sent anywhere", async () => {
  const action = approvalAction({
    actorId: "person",
    botId: "dev",
    toolRef: "computer_run_command",
    effect: "write",
    scope: "workspace",
    args: { command: "git switch -c x" },
    target: { workspace: true },
    continuation: continuation("git_branch", { action: "create", name: "x" }),
  });
  const { execute, connectorCalls } = harness({ nativeTools: () => [] });
  await expect(execute(action)).rejects.toThrow("no longer available");
  expect(connectorCalls).toHaveLength(0);
});

test("an approved open_pull_request goes to the connector with the arguments it was given", async () => {
  const args = {
    owner: "acme",
    repo: "app",
    title: "Add x",
    head: "feat/x",
    base: "main",
    body: "details",
  };
  const action = approvalAction({
    actorId: "person",
    botId: "dev",
    toolRef: "github/create_pull_request",
    effect: "write",
    scope: "github",
    args,
    target: { app: "github" },
    continuation: continuation("open_pull_request", args),
  });
  const { execute, connectorCalls, nativeRuns } = harness();
  await expect(execute(action)).resolves.toBe("opened");
  expect(connectorCalls).toMatchObject([
    { ref: "github/create_pull_request", args },
  ]);
  expect(nativeRuns).toEqual([]);
});
