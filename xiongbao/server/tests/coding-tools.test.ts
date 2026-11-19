import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { Observable } from "rxjs";
import { createShell } from "../../agent-computer/src/shell";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspacePathError,
} from "../../agent-computer/src/workspace";
import {
  codingToolsGuidance,
  EDIT_GUIDANCE,
  SEARCH_GUIDANCE,
  VERIFY_GUIDANCE,
} from "../../shared/verify";
import { createTurnRunner } from "../../toolkit/src/run-turn";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import {
  ruleMatches,
  securityFloor,
  toolDisabled,
} from "../src/approvals/policy";
import { DEFAULT_EMPLOYEE_SECURITY } from "../src/approvals/types";
import { botSeat } from "../src/computer/computer-key";
import {
  approvalEffectOf,
  createComputerGateway,
  intentOf,
} from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import type { RuntimeModel } from "../src/copilot";
import { untrustedNotice } from "../src/untrusted-content";
import { fetchDouble } from "./support/fetch-double";

/*
 * 期五 D: the coding primitives, through the server. A line range of a file, one passage replaced
 * (`computer_edit_file`, on the write's terms), a content search (`computer_grep`) and a search by
 * name (`computer_glob`), on the read's and the listing's. The computer behind the gateway is the
 * real workspace and shell code on a temporary folder, reached by the gateway's own HTTP calls.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coding-tools-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The computer's file and shell routes, answered by the real workspace and shell on `dir`. */
function realComputer(root: string, seen: string[] = []) {
  const files = createWorkspace(root);
  const shell = createShell(root, process.env, { oneShot: true });
  return fetchDouble(async (url, init) => {
    const path = new URL(String(url)).pathname;
    seen.push(path);
    const body = JSON.parse(String(init?.body ?? "{}"));
    try {
      switch (path) {
        case "/files/read":
          return Response.json(
            await files.read(body.path, {
              ...(body.offset ? { offset: body.offset } : {}),
              ...(body.limit ? { limit: body.limit } : {}),
            }),
          );
        case "/files/write":
          return Response.json(await files.write(body.path, body.contents));
        case "/files/edit":
          return Response.json(
            await files.edit(body.path, body.old_string, body.new_string, {
              replaceAll: body.replace_all === true,
            }),
          );
        case "/files/grep":
          return Response.json(
            await files.grep({
              pattern: body.pattern,
              path: body.path,
              glob: body.glob,
              ignoreCase: body.ignore_case === true,
            }),
          );
        case "/files/glob":
          return Response.json(
            await files.glob({ pattern: body.pattern, path: body.path }),
          );
        case "/exec":
          return Response.json(
            await shell.run({
              command: body.command,
              timeoutMs: body.timeoutMs,
            }),
          );
        default:
          return Response.json({ error: "Not here." }, { status: 404 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json(
        { error: message },
        {
          status:
            error instanceof WorkspacePathError
              ? 403
              : error instanceof WorkspaceFileError
                ? 404
                : 500,
        },
      );
    }
  });
}

function gatewayOn(root: string, seen: string[] = []) {
  return createComputerGateway({
    provider: {
      name: "test",
      isolation: "per-person",
      locate: async () => "http://computer:4100",
      status: async (seat) => ({ botId: seat.botId, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: true }),
      reset: async () => ({ cleared: true }),
    },
    auditStore: { insert: async () => {} },
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    fetchImpl: realComputer(root, seen),
  });
}

const actor = {
  id: "owner",
  userId: "owner",
  initiator: { kind: "routine" as const, id: "routine" },
};

function toolsOn(root: string, disabled?: (ref: string) => boolean) {
  const tools = createHeadlessComputerTools({
    gateway: gatewayOn(root),
    seat: botSeat("bot"),
    actor,
    ...(disabled ? { disabled } : {}),
  });
  const invoke = (name: string, args: unknown) => {
    const tool = tools.find((each) => each.definition.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    return tool.execute(args, {
      toolCallId: `${name}-${Math.random()}`,
      signal: new AbortController().signal,
    }) as Promise<Record<string, unknown>>;
  };
  return { tools, invoke };
}

describe("the coding tools, as the model is offered them", () => {
  test("edit, grep and glob are offered beside the file tools, with their parameters", () => {
    const { tools } = toolsOn(dir);
    const parameters = (name: string) => {
      const tool = tools.find((each) => each.definition.name === name);
      if (!tool) throw new Error(`Missing ${name}`);
      return Object.keys(
        (tool.definition.parameters as { properties: object }).properties,
      );
    };
    expect(parameters("computer_edit_file")).toEqual([
      "path",
      "old_string",
      "new_string",
      "replace_all",
    ]);
    expect(parameters("computer_grep")).toEqual([
      "pattern",
      "path",
      "glob",
      "ignore_case",
    ]);
    expect(parameters("computer_glob")).toEqual(["pattern", "path"]);
    expect(parameters("computer_read_file")).toEqual([
      "path",
      "root",
      "offset",
      "limit",
    ]);
    const edit = tools.find(
      (tool) => tool.definition.name === "computer_edit_file",
    );
    expect(edit?.definition.description).toContain("exactly once");
    expect(edit?.definition.description).toContain("computer_write_file");
  });

  test("a switch that disables saving files disables the edit; reading takes grep, listing takes glob", () => {
    const names = (off: string) =>
      toolsOn(dir, (ref) => ref === off).tools.map(
        (tool) => tool.definition.name,
      );
    expect(names("computer_write_file")).not.toContain("computer_edit_file");
    expect(names("computer_read_file")).not.toContain("computer_grep");
    expect(names("computer_list_files")).not.toContain("computer_glob");
    // Each can be switched off on its own too.
    expect(names("computer_edit_file")).toContain("computer_write_file");
    expect(names("computer_edit_file")).not.toContain("computer_edit_file");
  });
});

describe("through the gateway, on a real workspace", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "app.ts"),
      "const a = 1;\nconst b = 2;\nconst a2 = 1;\n",
    );
  });
  const file = () => readFileSync(join(dir, "src", "app.ts"), "utf8");

  test("read: a line range comes back numbered; without one, the file as it always did", async () => {
    const { invoke } = toolsOn(dir);
    expect(
      await invoke("computer_read_file", {
        path: "src/app.ts",
        offset: 2,
        limit: 2,
      }),
    ).toMatchObject({
      ok: true,
      text: "     2\tconst b = 2;\n     3\tconst a2 = 1;\n",
      startLine: 2,
      endLine: 3,
      totalLines: 3,
    });
    const whole = await invoke("computer_read_file", { path: "src/app.ts" });
    expect(whole).toMatchObject({
      ok: true,
      text: "const a = 1;\nconst b = 2;\nconst a2 = 1;\n",
    });
    expect(whole).not.toHaveProperty("startLine");
    // A line number from 0, or a fraction, is the model's mistake.
    await expect(
      invoke("computer_read_file", { path: "src/app.ts", offset: 0 }),
    ).rejects.toThrow();
  });

  test("edit: the one passage is replaced; a missing or doubled one is answered, not thrown", async () => {
    const { invoke } = toolsOn(dir);
    expect(
      await invoke("computer_edit_file", {
        path: "src/app.ts",
        old_string: "const b = 2;",
        new_string: "const b = 3;",
      }),
    ).toMatchObject({ ok: true, edited: true, replacements: 1 });
    expect(file()).toBe("const a = 1;\nconst b = 3;\nconst a2 = 1;\n");

    const missing = await invoke("computer_edit_file", {
      path: "src/app.ts",
      old_string: "const z = 0;",
      new_string: "x",
    });
    expect(missing).toMatchObject({
      ok: false,
      error: expect.stringContaining("没有找到 old_string"),
    });

    const doubled = await invoke("computer_edit_file", {
      path: "src/app.ts",
      old_string: "= 1;",
      new_string: "= 7;",
    });
    expect(doubled).toMatchObject({
      ok: false,
      error: expect.stringContaining("出现了 2 次"),
    });
    expect(file()).toBe("const a = 1;\nconst b = 3;\nconst a2 = 1;\n");

    expect(
      await invoke("computer_edit_file", {
        path: "src/app.ts",
        old_string: "= 1;",
        new_string: "= 7;",
        replace_all: true,
      }),
    ).toMatchObject({ ok: true, replacements: 2 });
    expect(file()).toBe("const a = 7;\nconst b = 3;\nconst a2 = 7;\n");
  });

  test("grep: matching lines, marked as outside content; a bad pattern is answered", async () => {
    const { invoke } = toolsOn(dir);
    const found = await invoke("computer_grep", { pattern: "const a\\d?" });
    expect(found).toMatchObject({ ok: true, matches: 2, truncated: false });
    expect(String(found.text).split("\n")).toEqual([
      "src/app.ts:1:const a = 1;",
      "src/app.ts:3:const a2 = 1;",
    ]);
    expect(String(found.untrusted)).toContain(
      untrustedNotice("workspace file content"),
    );
    expect(await invoke("computer_grep", { pattern: "(" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("搜索没有完成"),
    });
  });

  test("glob: the matching paths", async () => {
    const { invoke } = toolsOn(dir);
    writeFileSync(join(dir, "src", "notes.md"), "");
    expect(await invoke("computer_glob", { pattern: "**/*.ts" })).toMatchObject(
      { ok: true, paths: ["src/app.ts"], truncated: false },
    );
  });
});

describe("on the write's, the read's and the listing's terms", () => {
  test("each reaches the policy with the intent of the tool it stands beside", () => {
    expect(intentOf("computer_edit_file", undefined)).toBe("write_file");
    expect(intentOf("computer_grep", undefined)).toBe("read_file");
    expect(intentOf("computer_glob", undefined)).toBe("list_files");
    expect(approvalEffectOf(intentOf("computer_edit_file", undefined))).toBe(
      "write",
    );
    expect(approvalEffectOf(intentOf("computer_grep", undefined))).toBe("read");
    expect(approvalEffectOf(intentOf("computer_glob", undefined))).toBe("read");
  });

  test("a rule about saving files covers an edit; the floor on secret files covers it too", () => {
    const disable = {
      id: "rule-write",
      botId: "*",
      toolRef: "computer_write_file",
      effect: "*",
      scope: "*",
      behaviour: "deny" as const,
    };
    expect(
      toolDisabled({ botId: "bot", toolRef: "computer_edit_file" }, [
        [disable],
      ]),
    ).toBe(true);
    expect(
      toolDisabled({ botId: "bot", toolRef: "computer_grep" }, [[disable]]),
    ).toBe(false);
    const edit = {
      actorId: "owner",
      botId: "bot",
      toolRef: "computer_edit_file",
      effect: "write",
      scope: "workspace",
      args: {},
      target: { filePath: ".ssh/id_rsa" },
    };
    expect(ruleMatches({ ...disable, behaviour: "ask" as const }, edit)).toBe(
      true,
    );
    expect(securityFloor(edit, DEFAULT_EMPLOYEE_SECURITY)?.source).toBe(
      "sensitive_path",
    );
    expect(
      securityFloor(
        { ...edit, toolRef: "computer_grep", effect: "read" },
        DEFAULT_EMPLOYEE_SECURITY,
      )?.source,
    ).toBe("sensitive_path");
    expect(
      securityFloor(
        { ...edit, target: { filePath: "src/app.ts" } },
        DEFAULT_EMPLOYEE_SECURITY,
      ),
    ).toBeUndefined();
  });

  test("a read-only project refuses an edit before the machine is asked, and may be searched", async () => {
    const posted: { action: string; payload: Record<string, unknown> }[] = [];
    const gateway = createComputerGateway({
      provider: {
        name: "unused",
        isolation: "per-person",
        locate: async () => {
          throw new Error("A paired machine is never located here.");
        },
        status: async (seat) => ({ botId: seat.botId, state: "ready" }),
        list: async () => [],
        stop: async () => ({ wasRunning: false }),
        reset: async () => ({ cleared: false }),
      },
      transport: {
        post: async <T>(
          _address: unknown,
          _bot: unknown,
          path: string,
          payload: unknown,
        ) => {
          posted.push({
            action: path,
            payload: payload as Record<string, unknown>,
          });
          return (
            path === "/files/grep"
              ? {
                  pattern: "a",
                  path: ".",
                  engine: "rg",
                  matches: 0,
                  text: "",
                  truncated: false,
                }
              : { pattern: "*", path: ".", paths: [], truncated: false }
          ) as T;
        },
      } as never,
      resolveDevice: async () => ({ tenantId: "owner", deviceId: "laptop" }),
      projects: {
        resolve: async () => ({
          ok: true,
          projectId: "project",
          rootRef: "fld_READONLY",
          writable: false,
        }),
      },
      auditStore: { insert: async () => {} },
      policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    });
    const seat = botSeat("bot");
    await expect(
      gateway.editFile(seat, actor, {
        path: "src/app.ts",
        old_string: "a",
        new_string: "b",
      }),
    ).rejects.toThrow("只读");
    expect(posted).toEqual([]);
    await gateway.grep(seat, actor, { pattern: "a" });
    await gateway.glob(seat, actor, { pattern: "*" });
    expect(posted.map((each) => [each.action, each.payload.root])).toEqual([
      ["/files/grep", "fld_READONLY"],
      ["/files/glob", "fld_READONLY"],
    ]);
    // Never told writable for a read.
    expect(posted.every((each) => each.payload.writable === undefined)).toBe(
      true,
    );
  });
});

describe("the prompt", () => {
  test("a run that holds the coding tools is told to edit by passage and to search", () => {
    expect(
      codingToolsGuidance([
        "computer_edit_file",
        "computer_grep",
        "computer_glob",
      ]),
    ).toBe(`${EDIT_GUIDANCE}\n\n${SEARCH_GUIDANCE}`);
    expect(EDIT_GUIDANCE).toContain("不要用 computer_write_file 整文件重写");
    expect(SEARCH_GUIDANCE).toContain("computer_grep");
    expect(SEARCH_GUIDANCE).toContain("computer_glob");
    expect(codingToolsGuidance(["computer_read_file"])).toBeUndefined();
    expect(codingToolsGuidance(["computer_grep"])).toBe(SEARCH_GUIDANCE);
  });
});

/*
 * The whole path with a model (aimock, a real OpenAI-compatible server): a routine's turn through
 * the headless turn runner, holding the unattended computer tools. The model searches, reads the
 * lines it found, edits the one passage and runs the project's test, and every step lands on the
 * real files.
 */
describe("a turn that fixes a bug", () => {
  let llm: LLMock;
  let originalBase: string | undefined;
  let asked: ChatCompletionRequest[];

  beforeEach(async () => {
    llm = new LLMock();
    asked = [];
    originalBase = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = await llm.start();
  });
  afterEach(async () => {
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
    await llm.stop();
  });

  const model: RuntimeModel = {
    provider: "openai",
    defaultModel: "gpt-5.6-terra",
  };
  const bot = {
    id: "engineer",
    name: "Engineer",
    type: "built_in" as const,
    systemPrompt: "修代码。",
  };

  test.skipIf(process.platform === "win32")(
    "grep, read the lines, edit the passage, run the test: the bug is fixed and the test passes",
    async () => {
      mkdirSync(join(dir, "calc"), { recursive: true });
      writeFileSync(
        join(dir, "calc", "math_utils.py"),
        "def add(a, b):\n    return a - b\n\n\ndef twice(a):\n    return a * 2\n",
      );
      writeFileSync(
        join(dir, "test_math.py"),
        "import sys\nsys.path.insert(0, 'calc')\nfrom math_utils import add\nassert add(2, 3) == 5, add(2, 3)\nprint('OK')\n",
      );
      const seen: string[] = [];
      let calls = 0;
      const call = (name: string, args: unknown) => ({
        toolCalls: [
          { name, arguments: JSON.stringify(args), id: `call_${++calls}` },
        ],
      });
      const script = [
        call("computer_grep", { pattern: "def add", glob: "*.py" }),
        call("computer_read_file", {
          path: "calc/math_utils.py",
          offset: 1,
          limit: 2,
        }),
        call("computer_edit_file", {
          path: "calc/math_utils.py",
          old_string: "    return a - b",
          new_string: "    return a + b",
        }),
        call("computer_run_command", {
          command: "python3 test_math.py",
          timeoutMs: 60_000,
        }),
        {
          content: "已修复 add：python3 test_math.py 退出码 0，输出 OK。",
        },
      ];
      llm.on({ predicate: () => true }, (request) => {
        asked.push(request);
        return script[asked.length - 1] ?? { content: "?" };
      });

      const resolver = createActorAgentResolver({
        loadAgents: async () => [bot],
        model,
        resolveModelApiKey: async () => "synthetic-key",
      });
      const runTurn = createTurnRunner({
        admission: async () => new AbortController().signal,
        intelligence: {
          getOrCreateThread: async () => undefined,
          getThreadMessages: async () => ({ messages: [] }),
          ɵacquireThreadLock: async () => undefined,
          ɵrenewThreadLock: async () => undefined,
          ɵcleanupThreadLock: async () => undefined,
        },
        runner: {
          run: ({ agent, input }) =>
            new Observable((subscriber) => {
              agent
                .runAgent(input, {
                  onEvent: ({ event }) => subscriber.next(event),
                })
                .then(
                  () => subscriber.complete(),
                  (error) => subscriber.error(error),
                );
            }),
          stop: async () => true,
        },
        buildAgentFor: ({ ownerUserId, agentId, initiator }) =>
          resolver.resolveAgentForActor(
            { id: ownerUserId, role: "user" },
            agentId,
            { initiator },
          ),
        toolsForTurn: async () =>
          createHeadlessComputerTools({
            gateway: gatewayOn(dir, seen),
            seat: botSeat(bot.id),
            actor,
          }),
      });
      const { replyText } = await runTurn({
        ownerUserId: "owner",
        routineId: "routine",
        agentId: bot.id,
        threadId: "thread-fix",
        instruction: "add 算错了，修好它并跑测试。",
        initiator: { kind: "routine", id: "routine" },
      });

      expect(replyText).toContain("退出码 0");
      expect(seen).toEqual([
        "/files/grep",
        "/files/read",
        "/files/edit",
        "/exec",
      ]);
      expect(readFileSync(join(dir, "calc", "math_utils.py"), "utf8")).toBe(
        "def add(a, b):\n    return a + b\n\n\ndef twice(a):\n    return a * 2\n",
      );
      // What the model read back at each step, as the provider received it.
      const results = JSON.stringify(asked.at(-1)?.messages ?? []);
      expect(results).toContain("calc/math_utils.py:1:def add(a, b):");
      expect(results).toContain("     2\\\\t    return a - b");
      expect(results).toContain('\\"edited\\":true');
      expect(results).toContain('\\"exitCode\\":0');
      expect(results).toContain("OK");
      // The run held the shell and the coding tools, so it was told to verify and how to edit.
      const prompt = JSON.stringify(asked[0]?.messages ?? []);
      expect(prompt).toContain("<verify>");
      expect(prompt).toContain(VERIFY_GUIDANCE.slice(0, 20));
      expect(prompt).toContain("<coding_tools>");
    },
    30_000,
  );
});
