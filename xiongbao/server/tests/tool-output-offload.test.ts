import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShell } from "../../agent-computer/src/shell";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspacePathError,
} from "../../agent-computer/src/workspace";
import { botSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import {
  exceedsInline,
  excerpt,
  OUTPUT_HEAD_BYTES,
  OUTPUT_INLINE_BYTES,
  OUTPUT_TAIL_BYTES,
  type OutputSink,
  outputPath,
  WORKSPACE_OUTPUT_DIR,
  workspaceOutputSink,
} from "../src/tool-output";
import { webTools } from "../src/web/tools";
import { fetchDouble } from "./support/fetch-double";

/*
 * 期七：大段的工具输出存进员工的工作区，回传里只给头、尾和路径。命令输出、没指定行段的读文件、网页正文
 * 超过阈值（16KB）时才这样；没超过的原样回传；没有电脑可以存的，截断并说明。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tool-output-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 电脑的文件和命令路由，由真正的工作区和 shell 在 `dir` 上回答。`refuseWrites`：写文件一律 403。 */
function realComputer(root: string, options: { refuseWrites?: boolean } = {}) {
  const files = createWorkspace(root);
  const shell = createShell(root, process.env, { oneShot: true });
  return fetchDouble(async (url, init) => {
    const path = new URL(String(url)).pathname;
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
          if (options.refuseWrites)
            return Response.json({ error: "不让写。" }, { status: 403 });
          return Response.json(await files.write(body.path, body.contents));
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

function gatewayOn(root: string, options: { refuseWrites?: boolean } = {}) {
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
    fetchImpl: realComputer(root, options),
  });
}

const actor = {
  id: "owner",
  userId: "owner",
  initiator: { kind: "routine" as const, id: "routine" },
};

function toolsOn(root: string, options: { refuseWrites?: boolean } = {}) {
  const gateway = gatewayOn(root, options);
  const tools = createHeadlessComputerTools({
    gateway,
    seat: botSeat("bot"),
    actor,
  });
  const invoke = (
    name: string,
    args: unknown,
    toolCallId = "call-0123456789",
  ) => {
    const tool = tools.find((each) => each.definition.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    return tool.execute(args, {
      toolCallId,
      signal: new AbortController().signal,
    }) as Promise<Record<string, unknown>>;
  };
  return { gateway, invoke };
}

/** 第 n 行：每行都不一样，好认头尾。 */
const lineAt = (n: number) =>
  `line-${String(n).padStart(5, "0")} ${"x".repeat(60)}`;
const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => lineAt(index + 1)).join("\n");

const outputsIn = (root: string) =>
  existsSync(join(root, WORKSPACE_OUTPUT_DIR))
    ? readdirSync(join(root, WORKSPACE_OUTPUT_DIR))
    : [];

describe("阈值和截取", () => {
  test("16KB 是阈值，按 UTF-8 字节算：中文每字三个字节", () => {
    expect(OUTPUT_INLINE_BYTES).toBe(16 * 1024);
    expect(exceedsInline("a".repeat(OUTPUT_INLINE_BYTES))).toBe(false);
    expect(exceedsInline("a".repeat(OUTPUT_INLINE_BYTES + 1))).toBe(true);
    expect(exceedsInline("字".repeat(5_461))).toBe(false);
    expect(exceedsInline("字".repeat(5_462))).toBe(true);
  });

  test("头尾整行取，中间说明省略了多少；够短就原样", () => {
    const text = lines(2_000);
    const cut = excerpt(text);
    expect(cut.text.startsWith(lineAt(1))).toBe(true);
    expect(cut.text.endsWith(lineAt(2_000))).toBe(true);
    expect(cut.text).toContain("中间省略");
    expect(Buffer.byteLength(cut.text)).toBeLessThan(
      OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES + 200,
    );
    expect(cut.omittedLines).toBeGreaterThan(1_800);
    expect(excerpt("短").text).toBe("短");
    // 一整行比预算还长（压缩过的脚本）：硬切，不拆开多字节字符。
    const long = excerpt("字".repeat(30_000));
    expect(Buffer.byteLength(long.text)).toBeLessThan(7_000);
    expect(long.text).not.toContain("�");
  });

  test("路径：tool-outputs/<时间>-<工具>-<调用编号前八位>.txt", () => {
    expect(
      outputPath(
        "computer_run_command",
        "call_AbCd-1234xyz",
        new Date("2026-11-19T10:20:30.456Z"),
      ),
    ).toBe("tool-outputs/20261119-102030-computer_run_command-call_AbC.txt");
  });
});

describe("computer_run_command 的输出", () => {
  test("超过阈值：完整内容存进工作区，回传头、尾和路径", async () => {
    const { invoke } = toolsOn(dir);
    const result = await invoke(
      "computer_run_command",
      { command: "seq 1 8000" },
      "call-aaaaaaaa-0001",
    );
    // 回传：头和尾，不是全部。
    const stdout = String(result.stdout);
    expect(stdout.startsWith("1\n")).toBe(true);
    expect(stdout.trimEnd().endsWith("8000")).toBe(true);
    expect(stdout).toContain("中间省略");
    expect(Buffer.byteLength(stdout)).toBeLessThan(7_000);
    expect(result.exitCode).toBe(0);
    // 路径和说明。
    const saved = String(result.outputFile);
    expect(saved).toMatch(
      /^tool-outputs\/\d{8}-\d{6}-computer_run_command-callaaaa\.txt$/,
    );
    const note = String(result.outputNote);
    expect(note).toContain(saved);
    expect(note).toContain("computer_read_file");
    expect(note).toContain("computer_grep");
    // 文件里是完整内容。
    expect(outputsIn(dir)).toHaveLength(1);
    const file = readFileSync(join(dir, saved), "utf8");
    expect(file).toContain("$ seq 1 8000");
    expect(file).toContain("--- stdout ---");
    for (const n of [1, 4000, 8000]) expect(file).toContain(`\n${n}\n`);
    expect(file.split("\n").length).toBeGreaterThan(8_000);
    // 按行段读回来，用的是员工自己的读文件工具。
    const read = await invoke("computer_read_file", {
      path: saved,
      offset: 4,
      limit: 3,
    });
    expect(read.startLine).toBe(4);
    expect(read.endLine).toBe(6);
    // 前三行是命令、退出码和 stdout 标记，第 4 行起才是输出的第一行。
    expect(String(read.text)).toContain("4\t1\n");
  });

  test("没超过阈值：原样回传，不落盘，没有多出来的字段", async () => {
    const { invoke } = toolsOn(dir);
    const result = await invoke("computer_run_command", {
      command: "seq 1 300",
    });
    expect(String(result.stdout)).toBe(
      `${Array.from({ length: 300 }, (_, index) => index + 1).join("\n")}\n`,
    );
    expect("outputFile" in result).toBe(false);
    expect("outputNote" in result).toBe(false);
    expect(outputsIn(dir)).toHaveLength(0);
  });

  test("刚好卡在阈值上的不动，多一个字节才动", async () => {
    const { invoke } = toolsOn(dir);
    const exact = await invoke("computer_run_command", {
      command: `head -c ${OUTPUT_INLINE_BYTES} /dev/zero | tr '\\0' 'a'`,
    });
    expect(Buffer.byteLength(String(exact.stdout))).toBe(OUTPUT_INLINE_BYTES);
    expect("outputFile" in exact).toBe(false);
    const over = await invoke("computer_run_command", {
      command: `head -c ${OUTPUT_INLINE_BYTES + 1} /dev/zero | tr '\\0' 'a'`,
    });
    expect(over.outputFile).toBeString();
  });

  test("写不进工作区（策略不让、项目只读）：截断，并说明完整内容没能存下来", async () => {
    const { invoke } = toolsOn(dir, { refuseWrites: true });
    const result = await invoke("computer_run_command", {
      command: "seq 1 8000",
    });
    expect("outputFile" in result).toBe(false);
    const stdout = String(result.stdout);
    expect(stdout).toContain("中间省略");
    expect(stdout.trimEnd().endsWith("8000")).toBe(true);
    expect(Buffer.byteLength(stdout)).toBeLessThan(OUTPUT_INLINE_BYTES + 200);
    expect(String(result.outputNote)).toContain("没能存下来");
    expect(outputsIn(dir)).toHaveLength(0);
  });
});

describe("computer_read_file 的读取结果", () => {
  test("没指定行段、文件很长：只给头尾，并说明怎么按行段读；文件本身不动，不抄一份", async () => {
    const { invoke, gateway } = toolsOn(dir);
    await gateway.writeFile(botSeat("bot"), actor, {
      path: "notes/big.txt",
      contents: lines(700),
    });
    const result = await invoke("computer_read_file", {
      path: "notes/big.txt",
    });
    const text = String(result.text);
    expect(text.startsWith(lineAt(1))).toBe(true);
    expect(text).toContain("中间省略");
    expect(Buffer.byteLength(text)).toBeLessThan(7_000);
    const note = String(result.outputNote);
    expect(note).toContain("notes/big.txt");
    expect(note).toContain("offset");
    expect(outputsIn(dir)).toHaveLength(0);
  });

  test("指定了行段：员工自己选的范围，原样给", async () => {
    const { invoke, gateway } = toolsOn(dir);
    await gateway.writeFile(botSeat("bot"), actor, {
      path: "notes/big.txt",
      contents: lines(700),
    });
    const result = await invoke("computer_read_file", {
      path: "notes/big.txt",
      offset: 1,
      limit: 700,
    });
    expect(String(result.text)).toContain(lineAt(350));
    expect(String(result.text)).not.toContain("中间省略");
    expect("outputNote" in result).toBe(false);
  });

  test("没超过阈值的文件原样给", async () => {
    const { invoke, gateway } = toolsOn(dir);
    await gateway.writeFile(botSeat("bot"), actor, {
      path: "small.txt",
      contents: lines(20),
    });
    const result = await invoke("computer_read_file", { path: "small.txt" });
    expect(result.text).toBe(lines(20));
    expect("outputNote" in result).toBe(false);
  });
});

describe("web_fetch 的正文", () => {
  const page = (body: string) => ({
    fetchImpl: (async () =>
      new Response(body, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      })) as unknown as typeof fetch,
    lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
    viaProxy: () => false,
  });
  const fetchTool = (body: string, saveOutput?: OutputSink) => {
    const [, fetchPage] = webTools({
      search: { problem: "没有配置。" },
      scope: "owner:bot",
      fetchPolicy: page(body),
      ...(saveOutput ? { saveOutput } : {}),
    });
    if (!fetchPage) throw new Error("web_fetch is missing");
    return async (args: unknown, toolCallId = "web-call-77") =>
      JSON.parse(
        (await fetchPage.execute(args, {
          toolCallId,
          signal: new AbortController().signal,
        } as never)) as string,
      ) as Record<string, unknown>;
  };

  test("有电脑：超过阈值的正文存进工作区，回传头尾和路径；存的是全文", async () => {
    const gateway = gatewayOn(dir);
    const fetched = fetchTool(
      lines(1_500),
      workspaceOutputSink({ gateway, seat: botSeat("bot"), actor }),
    );
    const answer = await fetched({
      url: "https://docs.example/long",
      max_chars: 100_000,
    });
    const content = String(answer.content);
    expect(content.startsWith(lineAt(1))).toBe(true);
    expect(content).toContain(lineAt(1_500));
    expect(content).toContain("中间省略");
    expect(Buffer.byteLength(content)).toBeLessThan(7_000);
    const saved = String(answer.saved_to);
    expect(saved).toMatch(
      /^tool-outputs\/\d{8}-\d{6}-web_fetch-webcall7\.txt$/,
    );
    expect(String(answer.truncated)).toContain(saved);
    expect(readFileSync(join(dir, saved), "utf8")).toBe(lines(1_500));
    expect(String(answer.untrusted)).toContain("untrusted data");
  });

  test("员工没有电脑（存盘回答空）：截断到阈值，说明已截断，也说了没有电脑存全文", async () => {
    const answer = await fetchTool(
      lines(1_500),
      async () => undefined,
    )({
      url: "https://docs.example/long",
      max_chars: 100_000,
    });
    const content = String(answer.content);
    expect(content.startsWith(lineAt(1))).toBe(true);
    expect(content).not.toContain(lineAt(1_500));
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(OUTPUT_INLINE_BYTES);
    expect(String(answer.truncated)).toContain("已截断");
    expect(String(answer.truncated)).toContain("没有电脑");
    expect("saved_to" in answer).toBe(false);
  });

  test("部署里根本没有电脑（没接存盘）：同样截到阈值并说明（用户 2026-11-19 同意）", async () => {
    const answer = await fetchTool(lines(1_500))({
      url: "https://docs.example/long",
    });
    const content = String(answer.content);
    expect(content.startsWith(lineAt(1))).toBe(true);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(OUTPUT_INLINE_BYTES);
    expect(String(answer.truncated)).toContain("已截断");
    expect("saved_to" in answer).toBe(false);
  });

  test("没超过阈值的网页原样回传", async () => {
    const answer = await fetchTool(lines(30))({
      url: "https://docs.example/short",
    });
    expect(answer.content).toBe(lines(30));
    expect("truncated" in answer).toBe(false);
    expect("saved_to" in answer).toBe(false);
  });
});
