import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AbstractAgent } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import {
  CHECK_VIDEO_TOOL,
  DOCUMENTS_GUIDANCE,
  GENERATE_IMAGE_TOOL,
  GENERATE_VIDEO_TOOL,
  mediaGuidance,
} from "../../shared/media";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { SLIM_DOCUMENTS, slimMediaGuidance } from "../src/agents/slim-guidance";
import { toolDisabled } from "../src/approvals/policy";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { RuntimeModel } from "../src/copilot";
import { readMediaConfig } from "../src/media/config";
import type { MediaStore, StoredMedia } from "../src/media/store";
import {
  CHECK_VIDEO_REF,
  GENERATE_IMAGE_REF,
  GENERATE_VIDEO_REF,
  mediaTools,
  offeredMediaTools,
  videoTaskNumber,
} from "../src/media/tools";
import type { GrantedTool } from "../src/plugins/tools";
import { currentTenant } from "../src/tenant/context";

/*
 * 期五 C：员工生成图片和视频。工具走通用接口（OpenAI 兼容的 images/generations 与 videos），智谱视频有
 * 自己的适配器；没配置时照实说缺哪几项；生成的文件存给这一轮的人，返回 /api/media/<id>。
 *
 * 生成服务是本机起的假服务（Bun.serve），出站校验按开发配置放行本机地址，其它规矩照旧：不跟随重定向，
 * 下载服务给的链接时不带密钥。
 */

const OWNER = "media-owner";
const BOT = "media-bot";
const KEY = "sk-media-secret";
const outbound = { allowPrivateHosts: true };

/** A real 1x1 PNG, and the first bytes of an MP4 (`ftyp`), as a provider would answer them. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypmp42"),
  Buffer.alloc(64, 1),
]);

type Seen = {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
};

type Handler = (request: Request, url: URL) => Response | Promise<Response>;

let server: ReturnType<typeof Bun.serve>;
let base: string;
let seen: Seen[];
let handle: Handler;

beforeEach(() => {
  seen = [];
  handle = () => new Response("not found", { status: 404 });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const contentType = request.headers.get("content-type");
      let body: unknown;
      if (contentType?.includes("application/json"))
        body = await request.clone().json();
      else if (contentType?.includes("multipart/form-data")) {
        const form = await request.clone().formData();
        const fields: Record<string, unknown> = {};
        for (const [key, value] of form.entries())
          fields[key] =
            typeof value === "string"
              ? value
              : {
                  name: (value as File).name,
                  bytes: Buffer.from(await (value as File).arrayBuffer()),
                };
        body = fields;
      }
      seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        contentType,
        body,
      });
      return handle(request, url);
    },
  });
  base = `http://127.0.0.1:${server.port}/v1`;
});

afterEach(() => {
  server.stop(true);
});

/** An in-memory store that records the tenant frame each file was saved in. */
function memoryStore() {
  const files = new Map<
    string,
    StoredMedia & { tenant: string; prompt: string; agentId: string }
  >();
  let next = 0;
  const store: MediaStore = {
    async save(file) {
      next += 1;
      const id = `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
      files.set(id, {
        kind: file.kind,
        mimeType: file.mimeType,
        bytes: file.bytes,
        tenant: currentTenant(),
        prompt: file.prompt,
        agentId: file.agentId,
      });
      return id;
    },
    async read(id) {
      const file = files.get(id);
      return file && file.tenant === currentTenant() ? file : null;
    },
  };
  return { store, files };
}

function audit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = {
    insert: async (event) => {
      rows.push(event);
    },
  };
  return { store, rows };
}

const environment = (extra: Record<string, string> = {}) => ({
  XIONGBAO_IMAGE_BASE_URL: base,
  XIONGBAO_IMAGE_API_KEY: KEY,
  XIONGBAO_IMAGE_MODEL: "image-model-1",
  XIONGBAO_VIDEO_BASE_URL: base,
  XIONGBAO_VIDEO_API_KEY: KEY,
  XIONGBAO_VIDEO_MODEL: "video-model-1",
  ...extra,
});

function tools(
  env: Record<string, string | undefined>,
  options: {
    now?: () => number;
    waitMs?: number;
    store?: MediaStore;
    auditStore?: AuditStore;
  } = {},
) {
  const { store } = options.store ? { store: options.store } : memoryStore();
  const list = mediaTools({
    config: readMediaConfig(env, outbound),
    store,
    ownerUserId: OWNER,
    agentId: BOT,
    outbound,
    ...(options.auditStore ? { auditStore: options.auditStore } : {}),
    sleep: async () => undefined,
    pollMs: 10_000,
    ...(options.now ? { now: options.now } : {}),
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
  });
  const byName = (name: string) => {
    const tool = list.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no ${name}`);
    return tool;
  };
  return {
    image: byName(GENERATE_IMAGE_TOOL),
    video: byName(GENERATE_VIDEO_TOOL),
    check: byName(CHECK_VIDEO_TOOL),
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const MEDIA_LINK = /\/api\/media\/([0-9a-f-]{36})/g;
const linksIn = (text: string) =>
  [...text.matchAll(MEDIA_LINK)].map((match) => match[1] as string);

describe("not configured", () => {
  test("each tool says, in words, which settings are missing, and calls nobody", async () => {
    const { image, video, check } = tools({});
    const said = await image.execute({ prompt: "一只熊猫" });
    expect(said).toContain("还没有配置生成图片的服务");
    for (const name of [
      "XIONGBAO_IMAGE_BASE_URL",
      "XIONGBAO_IMAGE_API_KEY",
      "XIONGBAO_IMAGE_MODEL",
    ])
      expect(said).toContain(name);
    expect(await video.execute({ prompt: "熊猫跳舞" })).toContain(
      "XIONGBAO_VIDEO_API_KEY",
    );
    expect(
      await check.execute({ task_id: videoTaskNumber(Date.now(), "t1") }),
    ).toContain("还没有配置生成视频的服务");
    // Only the key missing: only the key is named.
    const keyless = await tools(
      environment({ XIONGBAO_IMAGE_API_KEY: " " }),
    ).image.execute({
      prompt: "一只熊猫",
    });
    expect(keyless).toContain("XIONGBAO_IMAGE_API_KEY");
    expect(keyless).not.toContain("XIONGBAO_IMAGE_BASE_URL");
    expect(seen).toEqual([]);
  });

  test("a video provider nobody knows is named, not guessed at", async () => {
    const said = await tools(
      environment({ XIONGBAO_VIDEO_PROVIDER: "sora-direct" }),
    ).video.execute({
      prompt: "熊猫跳舞",
    });
    expect(said).toContain("XIONGBAO_VIDEO_PROVIDER");
    expect(said).toContain("sora-direct");
    expect(seen).toEqual([]);
  });
});

describe("generate_image, through the OpenAI-compatible images endpoint", () => {
  test("sends model, prompt, n and size with the key, saves each picture for the person, and answers links to show", async () => {
    handle = () =>
      json({
        created: 1,
        data: [
          { b64_json: PNG.toString("base64") },
          { b64_json: PNG.toString("base64") },
        ],
      });
    const { store, files } = memoryStore();
    const counted = audit();
    const { image } = tools(environment(), {
      store,
      auditStore: counted.store,
    });
    const said = await image.execute({
      prompt: "海报：熊宝在月球上",
      size: "1024x1792",
      n: 2,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/v1/images/generations",
      authorization: `Bearer ${KEY}`,
      body: {
        model: "image-model-1",
        prompt: "海报：熊宝在月球上",
        n: 2,
        size: "1024x1792",
      },
    });
    const ids = linksIn(said);
    expect(ids).toHaveLength(2);
    expect(said).toContain(`![图片 1](/api/media/${ids[0]})`);
    for (const id of ids) {
      const file = files.get(id);
      expect(file?.mimeType).toBe("image/png");
      expect(Buffer.from(file?.bytes ?? []).equals(PNG)).toBe(true);
      // Saved in the frame of the person whose turn asked for it.
      expect(file?.tenant).toBe(OWNER);
      expect(file?.agentId).toBe(BOT);
    }
    expect(counted.rows).toHaveLength(1);
    expect(counted.rows[0]).toMatchObject({
      eventType: "media.generated",
      targetType: "generated_media",
      payload: {
        bot: BOT,
        kind: "image",
        provider: "openai-compatible",
        model: "image-model-1",
        count: 2,
      },
    });
    expect(JSON.stringify(counted.rows)).not.toContain("海报");
  });

  test("a picture answered as a link is downloaded without the key", async () => {
    handle = (_request, url) =>
      url.pathname === "/cdn/a.png"
        ? new Response(PNG, {
            headers: { "content-type": "application/octet-stream" },
          })
        : json({
            data: [
              { url: `http://127.0.0.1:${server.port}/cdn/a.png?sig=abc` },
            ],
          });
    const { store, files } = memoryStore();
    const said = await tools(environment(), { store }).image.execute({
      prompt: "一只熊猫",
    });
    const [id] = linksIn(said);
    expect(files.get(id ?? "")?.mimeType).toBe("image/png");
    const download = seen.find((request) => request.path === "/cdn/a.png");
    expect(download?.authorization).toBeNull();
    // n defaults to one; size is left to the service.
    expect(seen[0]?.body).toEqual({
      model: "image-model-1",
      prompt: "一只熊猫",
      n: 1,
    });
  });

  test("an upstream refusal is a sentence with the service's reason, never the key", async () => {
    handle = () =>
      json(
        {
          error: {
            message: "Incorrect API key provided",
            type: "invalid_request_error",
          },
        },
        401,
      );
    const said = await tools(environment()).image.execute({
      prompt: "一只熊猫",
    });
    expect(said).toContain("图片没有生成出来");
    expect(said).toContain("HTTP 401");
    expect(said).toContain("Incorrect API key provided");
    expect(said).not.toContain(KEY);
  });

  test("an answer that is not a picture is refused, and nothing is saved", async () => {
    handle = () =>
      json({
        data: [{ b64_json: Buffer.from("<html>hi</html>").toString("base64") }],
      });
    const { store, files } = memoryStore();
    const said = await tools(environment(), { store }).image.execute({
      prompt: "一只熊猫",
    });
    expect(said).toContain("不是 PNG、JPEG、GIF 或 WebP 图片");
    expect(files.size).toBe(0);
    handle = () => json({ data: [] });
    expect(
      await tools(environment()).image.execute({ prompt: "一只熊猫" }),
    ).toContain("回答里没有图片");
  });

  test("arguments it cannot use are answered before anything is called", async () => {
    const { image } = tools(environment());
    expect(await image.execute({ prompt: "  " })).toContain("prompt 不能为空");
    expect(await image.execute({ prompt: "熊猫", n: 5 })).toContain(
      "n 只能是 1 到 4",
    );
    expect(await image.execute({ prompt: "熊猫", size: "big" })).toContain(
      "宽x高",
    );
    expect(await image.execute("not json")).toContain("prompt 不能为空");
    expect(seen).toEqual([]);
  });
});

describe("generate_video, through the OpenAI-compatible videos endpoint", () => {
  test("submits, polls until completed, downloads the content with the key and saves it", async () => {
    const statuses = ["queued", "in_progress", "completed"];
    handle = (request, url) => {
      if (request.method === "POST" && url.pathname === "/v1/videos")
        return json({
          id: "video_123",
          object: "video",
          status: "queued",
          progress: 0,
        });
      if (url.pathname === "/v1/videos/video_123")
        return json({
          id: "video_123",
          status: statuses.shift() ?? "completed",
          progress: 50,
        });
      if (url.pathname === "/v1/videos/video_123/content")
        return new Response(MP4, { headers: { "content-type": "video/mp4" } });
      return new Response("no", { status: 404 });
    };
    const { store, files } = memoryStore();
    const counted = audit();
    const said = await tools(environment(), {
      store,
      auditStore: counted.store,
    }).video.execute({
      prompt: "熊宝在海边跳舞",
      duration: 8,
    });
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/v1/videos",
      authorization: `Bearer ${KEY}`,
      body: { model: "video-model-1", prompt: "熊宝在海边跳舞", seconds: "8" },
    });
    expect(
      seen.filter((request) => request.path === "/v1/videos/video_123"),
    ).toHaveLength(3);
    expect(seen.at(-1)).toMatchObject({
      path: "/v1/videos/video_123/content",
      authorization: `Bearer ${KEY}`,
    });
    const [id] = linksIn(said);
    expect(said).toContain(`[视频](/api/media/${id})`);
    expect(files.get(id ?? "")).toMatchObject({
      kind: "video",
      mimeType: "video/mp4",
      tenant: OWNER,
    });
    expect(counted.rows[0]?.payload).toMatchObject({ kind: "video", count: 1 });
  });

  test("not done within the call: answers a task number, and check_video picks the video up later", async () => {
    let done = false;
    handle = (request, url) => {
      if (request.method === "POST")
        return json({ id: "video_slow", status: "queued" });
      if (url.pathname === "/v1/videos/video_slow")
        return json({
          status: done ? "completed" : "in_progress",
          progress: 30,
        });
      if (url.pathname === "/v1/videos/video_slow/content")
        return new Response(MP4);
      return new Response("no", { status: 404 });
    };
    let clock = 1_800_000_000_000;
    const now = () => {
      clock += 30_000;
      return clock;
    };
    const { store, files } = memoryStore();
    const { video, check } = tools(environment(), {
      now,
      waitMs: 60_000,
      store,
    });
    const first = await video.execute({ prompt: "熊宝在海边跳舞" });
    expect(first).toContain("视频还在生成，进度约 30%");
    const task = first.match(/任务号：(video-\S+)/)?.[1];
    expect(task).toStartWith("video-");
    expect(task).toEndWith("-video_slow");
    expect(first).toContain(CHECK_VIDEO_TOOL);
    expect(files.size).toBe(0);

    done = true;
    const second = await check.execute({ task_id: task });
    expect(linksIn(second)).toHaveLength(1);
    expect(files.size).toBe(1);
    // Only one job was ever submitted.
    expect(seen.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("still not done ten minutes after it was submitted: answered as timed out", async () => {
    handle = (request) =>
      request.method === "POST"
        ? json({ id: "video_stuck" })
        : json({ status: "in_progress" });
    let clock = 1_800_000_000_000;
    const { video, check } = tools(environment(), {
      now: () => {
        clock += 100_000;
        return clock;
      },
      waitMs: 10 * 60_000,
    });
    const said = await video.execute({ prompt: "熊宝在海边跳舞" });
    expect(said).toContain("视频生成超时");
    expect(said).toContain("10 分钟");

    // A task number from long ago is answered the same way by check_video.
    const stale = videoTaskNumber(Date.now() - 11 * 60_000, "video_stuck");
    expect(
      await tools(environment()).check.execute({ task_id: stale }),
    ).toContain("视频生成超时");
    expect(await check.execute({ task_id: "whatever" })).toContain(
      "任务号不对",
    );
  });

  test("a failed job is a sentence with the service's reason", async () => {
    handle = (request) =>
      request.method === "POST"
        ? json({ id: "video_bad" })
        : json({
            status: "failed",
            error: {
              code: "moderation_blocked",
              message: "prompt was blocked",
            },
          });
    const said = await tools(environment()).video.execute({ prompt: "熊宝" });
    expect(said).toContain("视频没有生成出来");
    expect(said).toContain("prompt was blocked");
  });

  test("starts from a picture this deployment generated, sent as the input_reference file", async () => {
    handle = (request, url) => {
      if (url.pathname === "/v1/images/generations")
        return json({ data: [{ b64_json: PNG.toString("base64") }] });
      if (request.method === "POST" && url.pathname === "/v1/videos")
        return json({ id: "video_ref" });
      if (url.pathname === "/v1/videos/video_ref")
        return json({ status: "completed" });
      return new Response(MP4);
    };
    const { store } = memoryStore();
    const { image, video } = tools(environment(), { store });
    const [imageId] = linksIn(await image.execute({ prompt: "熊宝" }));
    const said = await video.execute({
      prompt: "让它动起来",
      image_url: `/api/media/${imageId}`,
    });
    expect(linksIn(said)).toHaveLength(1);
    const submitted = seen.find((request) => request.path === "/v1/videos")
      ?.body as {
      input_reference?: { bytes: Buffer };
    };
    expect(submitted.input_reference?.bytes.equals(PNG)).toBe(true);

    // A link that is neither ours nor https is refused before anything is submitted.
    const before = seen.length;
    expect(
      await video.execute({
        prompt: "动起来",
        image_url: "file:///etc/passwd",
      }),
    ).toContain("image_url 只能是");
    expect(
      await video.execute({
        prompt: "动起来",
        image_url: "/api/media/00000000-0000-4000-8000-999999999999",
      }),
    ).toContain("找不到");
    expect(seen.length).toBe(before);
  });
});

describe("the providers are replaced by configuration", () => {
  test("XIONGBAO_VIDEO_PROVIDER=zhipu speaks Zhipu's own video API: create, async-result, download the result link", async () => {
    let polls = 0;
    handle = (request, url) => {
      if (
        request.method === "POST" &&
        url.pathname === "/v1/videos/generations"
      )
        return json({
          id: "zp-task-1",
          model: "video-model-1",
          task_status: "PROCESSING",
          request_id: "r1",
        });
      if (url.pathname === "/v1/async-result/zp-task-1") {
        polls += 1;
        return polls < 2
          ? json({ task_status: "PROCESSING" })
          : json({
              task_status: "SUCCESS",
              video_result: [
                {
                  url: `http://127.0.0.1:${server.port}/cdn/v.mp4`,
                  cover_image_url: "x",
                },
              ],
            });
      }
      if (url.pathname === "/cdn/v.mp4") return new Response(MP4);
      return new Response("no", { status: 404 });
    };
    const { store, files } = memoryStore();
    const said = await tools(
      environment({ XIONGBAO_VIDEO_PROVIDER: "zhipu" }),
      { store },
    ).video.execute({
      prompt: "熊宝在雪地里打滚",
      duration: 5,
    });
    expect(seen[0]).toMatchObject({
      path: "/v1/videos/generations",
      authorization: `Bearer ${KEY}`,
      body: { model: "video-model-1", prompt: "熊宝在雪地里打滚", duration: 5 },
    });
    expect(
      seen.find((request) => request.path === "/cdn/v.mp4")?.authorization,
    ).toBeNull();
    const [id] = linksIn(said);
    expect(files.get(id ?? "")?.mimeType).toBe("video/mp4");
  });

  test("Zhipu's FAIL is a failed video", async () => {
    handle = (request) =>
      request.method === "POST"
        ? json({ id: "zp-2", task_status: "PROCESSING" })
        : json({ task_status: "FAIL" });
    expect(
      await tools(
        environment({ XIONGBAO_VIDEO_PROVIDER: "zhipu" }),
      ).video.execute({ prompt: "熊宝" }),
    ).toContain("视频没有生成出来");
  });

  test("images and videos each go to their own endpoint, key and model", async () => {
    const other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        seen.push({
          method: request.method,
          path: `other:${new URL(request.url).pathname}`,
          authorization: request.headers.get("authorization"),
          contentType: null,
          body: undefined,
        });
        return json({ data: [{ b64_json: PNG.toString("base64") }] });
      },
    });
    try {
      const env = environment({
        XIONGBAO_IMAGE_BASE_URL: `http://127.0.0.1:${other.port}/api/paas/v4/`,
        XIONGBAO_IMAGE_API_KEY: "image-only-key",
      });
      await tools(env).image.execute({ prompt: "熊宝" });
      expect(seen[0]).toMatchObject({
        path: "other:/api/paas/v4/images/generations",
        authorization: "Bearer image-only-key",
      });
    } finally {
      other.stop(true);
    }
  });
});

describe("who holds them", () => {
  test("every Bot is granted them with the tools it needs to be itself", () => {
    const index = readFileSync(
      join(import.meta.dir, "..", "src", "index.ts"),
      "utf8",
    );
    const granted = index.slice(
      index.indexOf("const loadGrantedToolsForActor = async ("),
    );
    const body = granted.slice(0, granted.indexOf("\n  ];\n"));
    expect(body).toContain("...mediaTools({");
    expect(index).toContain("return offeredMediaTools(");
  });

  test("a rule that switches one off leaves it out; switching off video takes check_video with it", () => {
    const list = tools(environment());
    const all = [list.image, list.video, list.check];
    expect(all.map((tool) => tool.ref)).toEqual([
      GENERATE_IMAGE_REF,
      GENERATE_VIDEO_REF,
      CHECK_VIDEO_REF,
    ]);
    const offered = (toolRef: string) =>
      offeredMediaTools(
        all.filter(
          (tool) =>
            !toolDisabled({ botId: BOT, toolRef: tool.ref }, [
              [
                {
                  id: "rule",
                  botId: BOT,
                  toolRef,
                  effect: "*",
                  scope: "*",
                  behaviour: "deny" as const,
                },
              ],
            ]),
        ),
      ).map((tool) => tool.name);
    expect(offered("nothing/else")).toEqual([
      GENERATE_IMAGE_TOOL,
      GENERATE_VIDEO_TOOL,
      CHECK_VIDEO_TOOL,
    ]);
    expect(offered(GENERATE_IMAGE_REF)).toEqual([
      GENERATE_VIDEO_TOOL,
      CHECK_VIDEO_TOOL,
    ]);
    expect(offered(GENERATE_VIDEO_REF)).toEqual([GENERATE_IMAGE_TOOL]);
  });
});

describe("the prompt", () => {
  const model: RuntimeModel = {
    provider: "openai",
    defaultModel: "gpt-5.6-terra",
  };
  const bot = {
    id: BOT,
    name: "Painter",
    type: "built_in" as const,
    systemPrompt: "Draw.",
  };
  let llm: LLMock;
  let originalBase: string | undefined;
  let asked: ChatCompletionRequest[];

  beforeEach(async () => {
    llm = new LLMock();
    asked = [];
    originalBase = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = await llm.start();
    llm.on({ predicate: () => true }, (request) => {
      asked.push(request);
      return { content: "好的。" };
    });
  });
  afterEach(async () => {
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
    await llm.stop();
  });

  const navigate = {
    name: "computer_navigate",
    description: "Open a web page.",
    parameters: { type: "object", properties: {} },
  };

  async function promptWith(
    granted: GrantedTool[],
    computer: "none" | "offered" | "used" = "none",
  ) {
    const agent = await createActorAgentResolver({
      loadAgents: async () => [bot],
      model,
      resolveModelApiKey: async () => "synthetic-key",
      loadToolsForActor: () => async () => granted,
      ...(computer === "none"
        ? {}
        : { computerGuidance: () => "COMPUTER GUIDANCE" }),
    }).resolveAgentForActor({ id: OWNER, role: "user" }, bot.id);
    const run = agent.clone() as AbstractAgent;
    run.setMessages([{ id: "ask", role: "user", content: "画一张图" }]);
    await run.runAgent(
      computer === "used"
        ? { tools: [navigate], forwardedProps: { xiongbaoAskedRun: true } }
        : {},
    );
    const sent = asked.at(-1)?.messages ?? [];
    // The system prompt, whichever role the provider's wire gives it.
    return String(
      sent.find((message) =>
        ["system", "developer"].includes(message.role as string),
      )?.content ?? "",
    );
  }

  test("a Bot holding the media tools is told how to use them; one without them is told nothing new", async () => {
    const list = tools(environment());
    const held = await promptWith([list.image, list.video, list.check]);
    const section = held.match(/<media>\n([\s\S]*?)\n<\/media>/)?.[1];
    // 用户 2026-11-20 批准：瘦身默认开，钉瘦身后的原文；关着时的原文见下面的 off 用例。
    expect(section).toBe(
      slimMediaGuidance(
        [GENERATE_IMAGE_TOOL, GENERATE_VIDEO_TOOL, CHECK_VIDEO_TOOL],
        { computer: false },
      ),
    );
    expect(section).toContain("要图片");
    expect(section).toContain("要视频用 generate_video");
    // No computer in this run: nothing about documents.
    expect(section).not.toContain(DOCUMENTS_GUIDANCE);
    expect(section).not.toContain(SLIM_DOCUMENTS);

    const without = await promptWith([]);
    expect(without).not.toContain("<media>");
    expect(without).not.toContain(GENERATE_IMAGE_TOOL);
  });

  test("a run that uses the computer is told how to make and check documents, and to read files with markitdown", async () => {
    const used = await promptWith([], "used");
    const section = used.match(/<media>\n([\s\S]*?)\n<\/media>/)?.[1];
    // 瘦身默认开：没有出图、出视频的工具时只有一行文档的说明（`SLIM_DOCUMENTS`）。
    expect(section).toBe(SLIM_DOCUMENTS);
    expect(section).toContain("`markitdown <文件>`");
    // Beside the computer's own section, which it does not change.
    expect(used).toContain("<computer>\nCOMPUTER GUIDANCE\n</computer>");

    const list = tools(environment());
    const both = await promptWith([list.image], "used");
    expect(both.match(/<media>\n([\s\S]*?)\n<\/media>/)?.[1]).toBe(
      slimMediaGuidance([GENERATE_IMAGE_TOOL], { computer: true }),
    );
  });

  test("with XIONGBAO_PROMPT_SLIM=off the section is the original, word for word", async () => {
    const saved = process.env.XIONGBAO_PROMPT_SLIM;
    process.env.XIONGBAO_PROMPT_SLIM = "off";
    try {
      const list = tools(environment());
      const held = await promptWith([list.image, list.video, list.check]);
      expect(held.match(/<media>\n([\s\S]*?)\n<\/media>/)?.[1]).toBe(
        mediaGuidance(
          [GENERATE_IMAGE_TOOL, GENERATE_VIDEO_TOOL, CHECK_VIDEO_TOOL],
          { computer: false },
        ),
      );
      const both = await promptWith([list.image], "used");
      expect(both.match(/<media>\n([\s\S]*?)\n<\/media>/)?.[1]).toBe(
        mediaGuidance([GENERATE_IMAGE_TOOL], { computer: true }),
      );
    } finally {
      if (saved === undefined) delete process.env.XIONGBAO_PROMPT_SLIM;
      else process.env.XIONGBAO_PROMPT_SLIM = saved;
    }
  });
});
