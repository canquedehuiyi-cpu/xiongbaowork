import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  currentApprovalContext,
  withApprovalContext,
} from "@xiongbao/toolkit/continuation";
import { GENERATE_IMAGE_TOOL } from "../../shared/media";
import type { ComputerSeat } from "../src/computer/computer-key";
import type { ActionActor } from "../src/computer/gateway";
import { readMediaConfig } from "../src/media/config";
import type { MediaStore, StoredMedia } from "../src/media/store";
import { mediaTools } from "../src/media/tools";
import { workspaceImagePath, workspaceMedia } from "../src/media/workspace";

/*
 * 跟进：员工生成的图片，在群聊里带上群的频道（群里其他成员才读得到），并且同时写进员工自己电脑的工作区，
 * 工具结果里给出路径。没有电脑时只有站内链接，不报错；写不进去时也不报错。
 *
 * 电脑网关是假的，但写文件、跑命令是真的：落在一个临时文件夹里，`base64 -d` 真的在跑，所以「内容与媒体
 * 存储一致」测的是真实字节。
 */
const OWNER = "group-media-owner";
const BOT = "group-media-bot";
const outbound = { allowPrivateHosts: true };
// 一张超过一次写入上限的图：文件头是真的 PNG，后面是随机字节，base64 后要分两段写。
const BIG_PNG = Buffer.concat([
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
  randomBytes(520_000),
]);
const SMALL_PNG = BIG_PNG.subarray(0, 69);

let server: ReturnType<typeof Bun.serve>;
let base: string;
let image: Buffer;
let work: string;

beforeEach(() => {
  image = BIG_PNG;
  work = mkdtempSync(join(tmpdir(), "media-workspace-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  base = `http://127.0.0.1:${server.port}/v1`;
});
afterEach(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

const environment = () => ({
  XIONGBAO_IMAGE_BASE_URL: base,
  XIONGBAO_IMAGE_API_KEY: "sk-test",
  XIONGBAO_IMAGE_MODEL: "image-model-1",
});

type Saved = StoredMedia & { channelId?: string };
function memoryStore() {
  const files = new Map<string, Saved>();
  const store: MediaStore = {
    async save(file) {
      const id = `00000000-0000-4000-8000-${String(files.size + 1).padStart(12, "0")}`;
      files.set(id, {
        kind: file.kind,
        mimeType: file.mimeType,
        bytes: file.bytes,
        ...(file.channelId ? { channelId: file.channelId } : {}),
      });
      return id;
    },
    async read(id) {
      return files.get(id) ?? null;
    },
  };
  return { store, files };
}

const seat = { botId: BOT, key: "seat" } as unknown as ComputerSeat;
const actor: ActionActor = { id: OWNER, userId: OWNER };

/** A computer whose files are a temporary folder and whose commands really run in it. */
function fakeComputer(options: { refuse?: boolean } = {}) {
  const calls: string[] = [];
  const contexts: unknown[] = [];
  const gateway = {
    async writeFile(
      _seat: unknown,
      _actor: unknown,
      input: { path: string; contents: string; append?: boolean },
    ) {
      calls.push(`write ${input.path} ${input.append ? "append" : "new"}`);
      contexts.push(currentApprovalContext());
      if (options.refuse) throw new Error("这一步要先问人，不能在这里做。");
      const target = join(work, input.path);
      mkdirSync(dirname(target), { recursive: true });
      if (input.append) appendFileSync(target, input.contents);
      else writeFileSync(target, input.contents);
      return {
        path: input.path,
        bytes: input.contents.length,
        appended: input.append === true,
      };
    },
    async runCommand(
      _seat: unknown,
      _actor: unknown,
      input: { command: string },
    ) {
      calls.push(`run ${input.command}`);
      contexts.push(currentApprovalContext());
      const run = Bun.spawnSync(["sh", "-c", input.command], { cwd: work });
      return {
        command: input.command,
        exitCode: run.exitCode,
        stdout: run.stdout.toString(),
        stderr: run.stderr.toString(),
        truncated: false,
        timedOut: false,
        elapsedMs: 1,
      };
    },
  };
  return { gateway, calls, contexts };
}

function imageTool(
  extra: Partial<Parameters<typeof mediaTools>[0]> & { store: MediaStore },
) {
  const tool = mediaTools({
    config: readMediaConfig(environment(), outbound),
    ownerUserId: OWNER,
    agentId: BOT,
    outbound,
    ...extra,
  }).find((candidate) => candidate.name === GENERATE_IMAGE_TOOL);
  if (!tool) throw new Error("no generate_image");
  return tool;
}

const inRun = <T>(threadId: string, work: () => Promise<T>) =>
  withApprovalContext(
    {
      runId: "run-1",
      threadId,
      toolCallId: "call-1",
      toolName: GENERATE_IMAGE_TOOL,
      args: {},
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
    work,
  );

const idOf = (text: string) =>
  text.match(/\/api\/media\/([0-9a-f-]{36})/)?.[1] ?? "";

describe("a picture in the coworker's own computer", () => {
  test("is written to generated/<id>.png with the same bytes as the media store, and the result names the path", async () => {
    const { store, files } = memoryStore();
    const computer = fakeComputer();
    const said = await imageTool({
      store,
      workspace: workspaceMedia({
        gateway: computer.gateway as never,
        resolve: async () => ({ seat, actor }),
      }),
    }).execute({ prompt: "一只熊猫" });

    const id = idOf(said);
    const path = workspaceImagePath(id, "image/png");
    expect(path).toBe(`generated/${id}.png`);
    expect(said).toContain(`电脑工作区里的文件：${path}`);
    expect(said).toContain(`![图片 1](/api/media/${id})`);
    expect(said).toContain("add_picture");
    // The same bytes, byte for byte, as the deployment's own copy.
    const onDisk = readFileSync(join(work, path));
    expect(onDisk.equals(Buffer.from(files.get(id)?.bytes ?? []))).toBe(true);
    expect(onDisk.equals(BIG_PNG)).toBe(true);
    // Two pieces of text went over (it is more than one write's worth), and no text is left behind.
    expect(computer.calls.filter((call) => call.startsWith("write"))).toEqual([
      `write ${path}.b64 new`,
      `write ${path}.b64 append`,
    ]);
    expect(readdirSync(join(work, "generated"))).toEqual([`${id}.png`]);
  });

  test("the writes are made outside the generating call's own approval context, so nothing can park that turn", async () => {
    const { store } = memoryStore();
    const computer = fakeComputer();
    await inRun("thread-1", () =>
      imageTool({
        store,
        workspace: workspaceMedia({
          gateway: computer.gateway as never,
          resolve: async () => ({ seat, actor }),
        }),
      }).execute({ prompt: "一只熊猫" }),
    );
    expect(computer.contexts.length).toBeGreaterThan(0);
    expect(computer.contexts.every((context) => context === undefined)).toBe(
      true,
    );
  });

  test("a coworker with no computer gets the link alone, and no error", async () => {
    const { store } = memoryStore();
    const said = await imageTool({
      store,
      workspace: workspaceMedia({
        gateway: fakeComputer().gateway as never,
        resolve: async () => undefined,
      }),
    }).execute({ prompt: "一只熊猫" });
    expect(said).toContain("已生成 1 张图片");
    expect(said).toContain(`![图片 1](/api/media/${idOf(said)})`);
    expect(said).not.toContain("电脑工作区");
    expect(said).toContain("告诉对方图片的地址");
    expect(existsSync(join(work, "generated"))).toBe(false);
    // And the same with no workspace wired at all.
    const bare = await imageTool({ store }).execute({ prompt: "一只熊猫" });
    expect(bare).not.toContain("电脑工作区");
    expect(bare).toContain("已生成 1 张图片");
  });

  test("a write the computer refuses leaves the link and says so, never an error", async () => {
    const { store } = memoryStore();
    const computer = fakeComputer({ refuse: true });
    const said = await imageTool({
      store,
      workspace: workspaceMedia({
        gateway: computer.gateway as never,
        resolve: async () => ({ seat, actor }),
      }),
    }).execute({ prompt: "一只熊猫" });
    expect(said).toContain("已生成 1 张图片");
    expect(said).toContain(`![图片 1](/api/media/${idOf(said)})`);
    expect(said).not.toContain("电脑工作区里的文件");
    expect(said).toContain("没能写进电脑工作区");
  });

  test("a computer that cannot decode it leaves nothing half-written", async () => {
    image = SMALL_PNG as Buffer;
    const { store } = memoryStore();
    const computer = fakeComputer();
    const broken = {
      ...computer.gateway,
      runCommand: async (
        _s: unknown,
        _a: unknown,
        input: { command: string },
      ) =>
        input.command.startsWith("rm")
          ? computer.gateway.runCommand(_s, _a, input)
          : {
              command: input.command,
              exitCode: 127,
              stdout: "",
              stderr: "base64: not found",
              truncated: false,
              timedOut: false,
              elapsedMs: 1,
            },
    };
    const said = await imageTool({
      store,
      workspace: workspaceMedia({
        gateway: broken as never,
        resolve: async () => ({ seat, actor }),
      }),
    }).execute({ prompt: "一只熊猫" });
    expect(said).toContain("没能写进电脑工作区");
    expect(readdirSync(join(work, "generated"))).toEqual([]);
  });
});

describe("a picture made in a group chat", () => {
  test("is filed under the group's channel, found from the run's own thread, for this person and coworker", async () => {
    const { store, files } = memoryStore();
    const asked: unknown[][] = [];
    const said = await inRun("group-thread", () =>
      imageTool({
        store,
        channelOf: async (...args) => {
          asked.push(args);
          return "channel-1";
        },
      }).execute({ prompt: "一只熊猫" }),
    );
    expect(asked).toEqual([[OWNER, BOT, "group-thread"]]);
    expect(files.get(idOf(said))?.channelId).toBe("channel-1");
  });

  test("in a chat of one, outside a run, or when the lookup fails, nothing is filed under a channel", async () => {
    const { store, files } = memoryStore();
    const lone = await inRun("one-thread", () =>
      imageTool({ store, channelOf: async () => null }).execute({
        prompt: "一只熊猫",
      }),
    );
    expect(files.get(idOf(lone))).not.toHaveProperty("channelId");
    const outside = await imageTool({
      store,
      channelOf: async () => "channel-1",
    }).execute({ prompt: "一只熊猫" });
    expect(files.get(idOf(outside))).not.toHaveProperty("channelId");
    const broken = await inRun("group-thread", () =>
      imageTool({
        store,
        channelOf: async () => {
          throw new Error("database down");
        },
      }).execute({ prompt: "一只熊猫" }),
    );
    expect(broken).toContain("已生成 1 张图片");
    expect(files.get(idOf(broken))).not.toHaveProperty("channelId");
  });
});
