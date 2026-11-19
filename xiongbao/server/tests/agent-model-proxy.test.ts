import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createAcpModelAccess,
  readAgentModelProxyConfig,
} from "../src/agents/model-proxy/access";
import {
  AGENT_MODEL_ROUTE,
  type AgentModelProxyDeps,
  createAgentModelProxy,
  mountAgentModelProxy,
} from "../src/agents/model-proxy/proxy";
import {
  AGENT_MODEL_TOKEN_PREFIX,
  createAgentModelTokens,
} from "../src/agents/model-proxy/token";
import type { AgentUpstream } from "../src/models/runtime-resolver";
import {
  type ModelTokenCallRow,
  sha256Hex,
} from "../src/models/token-metering";

/*
 * 外部员工的模型代理（agents/model-proxy）：令牌、转发、计量、拒绝。上游是假的（注入 fetch），
 * 记下收到了什么、按剧本回响应；数据库那一侧（员工删除后令牌作废、用量真的进 model_token_calls）
 * 在 agent-model-proxy.integration.test.ts。
 */

const KEY = "test-encryption-key-0123456789abcdef";
const REAL_KEY = "sk-real-upstream-key";
const TENANT = "user-tenant-a";
const OTHER_TENANT = "user-tenant-b";
const AGENT = "agent-codex-1";
const THREAD = "thread-1";

type Seen = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const metering = (provider: string, modelName: string) => ({
  tenantId: TENANT,
  agentId: AGENT,
  modelRef: "11111111-1111-4111-8111-111111111111",
  provider,
  modelName,
  credentialId: "22222222-2222-4222-8222-222222222222",
  credentialDigest: sha256Hex("credential"),
  originalModelFingerprint: sha256Hex("fingerprint"),
  originalText: `${provider}/${modelName}`,
});

const upstreamOf = (
  provider: string,
  modelName: string,
  baseUrl: string | null = null,
): AgentUpstream => ({
  provider,
  baseUrl,
  modelName,
  apiKey: REAL_KEY,
  metering: metering(provider, modelName),
});

const sse = (events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

type Script = (seen: Seen) => Response | Promise<Response>;

function setup(
  options: {
    upstream?: AgentUpstream | null;
    script?: Script;
    active?: (tenantId: string, agentId: string) => boolean;
    quota?: AgentModelProxyDeps["quota"];
    perMinute?: number;
    now?: () => number;
  } = {},
) {
  const clock = { at: 1_800_000_000_000 };
  const now = options.now ?? (() => clock.at);
  const tokens = createAgentModelTokens({ encryptionKey: KEY, now });
  const seen: Seen[] = [];
  const rows: ModelTokenCallRow[] = [];
  const script: Script =
    options.script ??
    (() =>
      Response.json({
        id: "r1",
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      }));
  const upstream =
    options.upstream === undefined
      ? upstreamOf("deepseek", "deepseek-chat")
      : options.upstream;
  const active =
    options.active ?? ((tenant, agent) => tenant === TENANT && agent === AGENT);
  const proxy = createAgentModelProxy({
    tokens,
    employeeActive: async (claims) => active(claims.tenantId, claims.agentId),
    resolveUpstream: async () => upstream,
    ...(options.quota ? { quota: options.quota } : {}),
    sink: async (row) => {
      rows.push(row);
    },
    outbound: {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      viaProxy: () => false,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, name) => {
          headers[name] = value;
        });
        const entry: Seen = {
          url: String(input),
          method: init?.method ?? "GET",
          headers,
          body: JSON.parse(String(init?.body ?? "{}")),
        };
        seen.push(entry);
        return script(entry);
      }) as typeof fetch,
    },
    ...(options.perMinute ? { perMinute: options.perMinute } : {}),
    now,
    log: () => undefined,
  });
  const pass = (
    claims: { tenantId?: string; agentId?: string; threadId?: string } = {},
  ) =>
    tokens.issue({
      tenantId: claims.tenantId ?? TENANT,
      agentId: claims.agentId ?? AGENT,
      threadId: claims.threadId ?? THREAD,
    }).token;
  const post = (
    wire: "responses" | "messages",
    body: unknown,
    headers: Record<string, string> = {},
    query = "",
  ) =>
    proxy.forward(
      new Request(
        `http://xiongbao.test${AGENT_MODEL_ROUTE}/v1/${wire}${query}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${pass()}`,
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
        },
      ),
      wire,
    );
  return { clock, tokens, proxy, seen, rows, pass, post };
}

async function bodyOf(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("the pass", () => {
  test("names its tenant, employee and thread, and is good for 12 hours", () => {
    const clock = { at: 1_800_000_000_000 };
    const tokens = createAgentModelTokens({
      encryptionKey: KEY,
      now: () => clock.at,
    });
    const { token, expiresAt } = tokens.issue({
      tenantId: TENANT,
      agentId: AGENT,
      threadId: THREAD,
    });
    expect(token.startsWith(AGENT_MODEL_TOKEN_PREFIX)).toBe(true);
    expect(expiresAt).toBe(clock.at + 12 * 60 * 60 * 1000);
    expect(tokens.verify(token)).toEqual({
      tenantId: TENANT,
      agentId: AGENT,
      threadId: THREAD,
      issuedAt: clock.at,
      expiresAt,
    });
    clock.at = expiresAt - 1;
    expect(tokens.verify(token)).not.toBeNull();
    clock.at = expiresAt;
    expect(tokens.verify(token)).toBeNull();
  });

  test("a pass signed with another key, altered, or not one of ours is nothing", () => {
    const tokens = createAgentModelTokens({ encryptionKey: KEY });
    const other = createAgentModelTokens({ encryptionKey: `${KEY}-other` });
    const { token } = tokens.issue({
      tenantId: TENANT,
      agentId: AGENT,
      threadId: THREAD,
    });
    expect(other.verify(token)).toBeNull();
    const [head, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        t: OTHER_TENANT,
        a: AGENT,
        h: THREAD,
        i: 1,
        e: 9e15,
      }),
    ).toString("base64url");
    expect(
      tokens.verify(`${AGENT_MODEL_TOKEN_PREFIX}${forged}.${signature}`),
    ).toBeNull();
    expect(tokens.verify(token.slice(0, -2))).toBeNull();
    expect(
      tokens.verify(token.replace(AGENT_MODEL_TOKEN_PREFIX, "sk-")),
    ).toBeNull();
    expect(tokens.verify(head)).toBeNull();
    expect(tokens.verify(undefined)).toBeNull();
    expect(tokens.verify("")).toBeNull();
  });

  test("revoking an employee cuts the passes issued before, not the ones issued after", () => {
    const clock = { at: 1_800_000_000_000 };
    const tokens = createAgentModelTokens({
      encryptionKey: KEY,
      now: () => clock.at,
    });
    const claims = { tenantId: TENANT, agentId: AGENT, threadId: THREAD };
    const before = tokens.issue(claims).token;
    const elsewhere = tokens.issue({ ...claims, agentId: "agent-2" }).token;
    clock.at += 1000;
    tokens.revoke({ tenantId: TENANT, agentId: AGENT });
    clock.at += 1000;
    const after = tokens.issue(claims).token;
    expect(tokens.verify(before)).toBeNull();
    expect(tokens.verify(after)).not.toBeNull();
    expect(tokens.verify(elsewhere)).not.toBeNull();
  });
});

describe("forwarding a Responses request (Codex)", () => {
  test("the model, the key and the address are the employee's, and the usage is recorded", async () => {
    const t = setup();
    const response = await t.post(
      "responses",
      { model: "gpt-5", input: "hi", stream: false },
      { "openai-beta": "x", "x-forwarded-for": "6.6.6.6" },
    );
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({ id: "r1" });
    expect(t.seen).toHaveLength(1);
    const [call] = t.seen;
    expect(call?.url).toBe("https://api.deepseek.com/responses");
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({
      model: "deepseek-chat",
      input: "hi",
      stream: false,
    });
    expect(call?.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    // The pass the agent presented goes nowhere.
    expect(JSON.stringify(call?.headers)).not.toContain(
      AGENT_MODEL_TOKEN_PREFIX,
    );
    expect(call?.headers).not.toHaveProperty("x-forwarded-for");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      tenantId: TENANT,
      agentId: AGENT,
      threadId: THREAD,
      provider: "deepseek",
      modelName: "deepseek-chat",
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    });
    expect(JSON.stringify(t.rows)).not.toContain(REAL_KEY);
  });

  test("a stream reaches the agent as it came, and its usage is recorded when it ends", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      { type: "response.output_text.delta", delta: "你" },
      { type: "response.output_text.delta", delta: "好" },
      {
        type: "response.completed",
        response: {
          id: "r1",
          model: "deepseek-chat",
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            total_tokens: 150,
            input_tokens_details: { cached_tokens: 100 },
            output_tokens_details: { reasoning_tokens: 12 },
          },
        },
      },
    ];
    const t = setup({
      script: () =>
        new Response(sse(events), {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const response = await t.post("responses", {
      model: "x",
      input: "hi",
      stream: true,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Not recorded while it is still being read.
    expect(t.rows).toHaveLength(0);
    expect(await response.text()).toBe(sse(events));
    expect(t.seen[0]?.body.model).toBe("deepseek-chat");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cachedInputTokens: 100,
      reasoningTokens: 12,
    });
  });

  test("a stream that is dropped part-way is recorded as stopped, with no usage invented", async () => {
    const t = setup({
      script: () =>
        new Response(
          sse([{ type: "response.output_text.delta", delta: "你" }]),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const response = await t.post("responses", { input: "hi", stream: true });
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      outcome: "stopped",
      usageStatus: "unknown",
      inputTokens: null,
      outputTokens: null,
    });
  });
});

describe("forwarding a Messages request (Claude Code)", () => {
  test("goes to the Anthropic-format address with the employee's model and key", async () => {
    const t = setup({
      script: () =>
        Response.json({
          id: "m1",
          model: "deepseek-chat",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 2,
            output_tokens: 8,
          },
        }),
    });
    const response = await t.post(
      "messages",
      { model: "claude-sonnet-4", max_tokens: 10, messages: [] },
      { "anthropic-beta": "tools-2024" },
      "?beta=true",
    );
    expect(response.status).toBe(200);
    const [call] = t.seen;
    expect(call?.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(call?.body.model).toBe("deepseek-chat");
    expect(call?.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(call?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call?.headers["anthropic-beta"]).toBe("tools-2024");
    expect(t.rows[0]).toMatchObject({
      outcome: "completed",
      usageStatus: "reported",
      // What the model was given: the fresh and the cached tokens together.
      inputTokens: 17,
      outputTokens: 8,
      totalTokens: 25,
      cachedInputTokens: 5,
      cacheWriteTokens: 2,
    });
  });

  test("a stream's input comes from its start and its output from its end", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          model: "deepseek-chat",
          usage: {
            input_tokens: 40,
            cache_read_input_tokens: 10,
            output_tokens: 1,
          },
        },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "好" },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 22 },
      },
      { type: "message_stop" },
    ];
    const t = setup({
      script: () =>
        new Response(sse(events), {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const response = await t.post("messages", { stream: true, messages: [] });
    expect(await response.text()).toBe(sse(events));
    expect(t.rows[0]).toMatchObject({
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 50,
      outputTokens: 22,
      cachedInputTokens: 10,
    });
  });

  test("an Anthropic model gets the key in x-api-key at Anthropic's own address", async () => {
    const t = setup({ upstream: upstreamOf("anthropic", "claude-sonnet-4-5") });
    await t.post(
      "messages",
      { messages: [] },
      { "anthropic-version": "2023-06-01" },
    );
    const [call] = t.seen;
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.headers["x-api-key"]).toBe(REAL_KEY);
    expect(call?.headers).not.toHaveProperty("authorization");
    expect(call?.body.model).toBe("claude-sonnet-4-5");
  });

  test("an OpenAI model gets Responses at OpenAI's own address", async () => {
    const t = setup({ upstream: upstreamOf("openai", "gpt-5") });
    await t.post("responses", { input: "hi" });
    expect(t.seen[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(t.seen[0]?.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
  });
});

describe("a model that cannot serve the agent", () => {
  test.each([
    ["responses", upstreamOf("zhipu", "glm-4"), "Codex"],
    ["responses", upstreamOf("anthropic", "claude-sonnet-4-5"), "Codex"],
    ["messages", upstreamOf("openai", "gpt-5"), "Claude Code"],
    ["messages", upstreamOf("moonshot", "kimi"), "Claude Code"],
  ] as const)(
    "%s on %p is refused in Chinese and nothing is sent",
    async (wire, upstream, harness) => {
      const t = setup({ upstream });
      const response = await t.post(wire, { input: "hi", messages: [] });
      expect(response.status).toBe(400);
      const text = JSON.stringify(await bodyOf(response));
      expect(text).toContain(`不支持 ${harness} 接入`);
      expect(text).toContain("请换成 DeepSeek 等兼容模型");
      expect(t.seen).toHaveLength(0);
      expect(t.rows).toHaveLength(0);
    },
  );

  test("an employee with no model of its own is told to pick one", async () => {
    const t = setup({ upstream: null });
    const response = await t.post("responses", { input: "hi" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await bodyOf(response))).toContain(
      "还没有可用的模型",
    );
    expect(t.seen).toHaveLength(0);
  });

  test("the error has the shape the agent's own client reads", async () => {
    const t = setup({ upstream: upstreamOf("zhipu", "glm-4") });
    const responses = await bodyOf(await t.post("responses", { input: "hi" }));
    expect(responses).toHaveProperty("error.message");
    const messages = await bodyOf(await t.post("messages", { messages: [] }));
    expect(messages).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });
});

describe("who may ask", () => {
  const ask = (t: ReturnType<typeof setup>, authorization?: string) =>
    t.proxy.forward(
      new Request("http://xiongbao.test/api/agent-model/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ input: "hi" }),
      }),
      "responses",
    );

  test("no pass, a made-up one, and an altered one are 401", async () => {
    const t = setup();
    expect((await ask(t)).status).toBe(401);
    expect((await ask(t, "Bearer sk-not-ours")).status).toBe(401);
    expect((await ask(t, `Bearer ${t.pass().slice(0, -3)}abc`)).status).toBe(
      401,
    );
    expect(t.seen).toHaveLength(0);
    const refused = JSON.stringify(await bodyOf(await ask(t)));
    expect(refused).toContain("令牌无效或已过期");
  });

  test("the x-api-key header carries a pass as well as Authorization", async () => {
    const t = setup();
    const response = await t.proxy.forward(
      new Request("http://xiongbao.test/api/agent-model/v1/messages", {
        method: "POST",
        headers: { "x-api-key": t.pass(), "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
      "messages",
    );
    expect(response.status).toBe(200);
  });

  test("an expired pass is 401", async () => {
    const t = setup();
    const pass = t.pass();
    t.clock.at += 12 * 60 * 60 * 1000 + 1;
    expect((await ask(t, `Bearer ${pass}`)).status).toBe(401);
    expect(t.seen).toHaveLength(0);
  });

  test("a pass for an employee that is gone, or for another tenant's employee, is 403", async () => {
    const t = setup();
    // Tenant B holding a pass that names tenant A's employee: not tenant B's employee.
    const crossTenant = t.pass({ tenantId: OTHER_TENANT });
    expect((await ask(t, `Bearer ${crossTenant}`)).status).toBe(403);
    // Tenant A holding a pass that names an employee that is not its own.
    const crossEmployee = t.pass({ agentId: "agent-of-someone-else" });
    expect((await ask(t, `Bearer ${crossEmployee}`)).status).toBe(403);
    expect(t.seen).toHaveLength(0);
    expect(t.rows).toHaveLength(0);
  });

  test("an employee deleted after the pass was issued stops working at once", async () => {
    let deleted = false;
    const t = setup({
      active: (tenant, agent) =>
        !deleted && tenant === TENANT && agent === AGENT,
    });
    const pass = t.pass();
    expect((await ask(t, `Bearer ${pass}`)).status).toBe(200);
    deleted = true;
    expect((await ask(t, `Bearer ${pass}`)).status).toBe(403);
  });

  test("a pass that names a tenant nobody is billed as is 401", async () => {
    const t = setup({ active: () => true });
    for (const tenantId of ["platform", "system", "team"])
      expect((await ask(t, `Bearer ${t.pass({ tenantId })}`)).status).toBe(401);
  });
});

describe("how much", () => {
  test("a tenant over its allowance is 429 with the reason in Chinese, and nothing is sent", async () => {
    const t = setup({ quota: async () => "本月任务额度已用完（51/50）。" });
    const response = await t.post("responses", { input: "hi" });
    expect(response.status).toBe(429);
    expect(JSON.stringify(await bodyOf(response))).toContain(
      "本月任务额度已用完",
    );
    expect(t.seen).toHaveLength(0);
    expect(t.rows).toHaveLength(0);
  });

  test("an employee asking too fast is 429 with how long to wait, and the minute passes", async () => {
    const t = setup({ perMinute: 2 });
    expect((await t.post("responses", { input: "1" })).status).toBe(200);
    expect((await t.post("responses", { input: "2" })).status).toBe(200);
    const third = await t.post("responses", { input: "3" });
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(t.seen).toHaveLength(2);
    t.clock.at += 61_000;
    expect((await t.post("responses", { input: "4" })).status).toBe(200);
  });
});

describe("where it goes", () => {
  test("nothing the agent sends names another address", async () => {
    const t = setup();
    await t.post(
      "responses",
      {
        input: "hi",
        base_url: "http://evil.test",
        baseUrl: "http://evil.test",
        api_base: "http://evil.test",
      },
      {
        "x-upstream-url": "http://evil.test/v1",
        "x-forwarded-host": "evil.test",
        host: "evil.test",
      },
      "?base_url=http://evil.test&upstream=http://evil.test",
    );
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0]?.url).toBe("https://api.deepseek.com/responses");
    expect(JSON.stringify(t.seen[0]?.headers)).not.toContain("evil.test");
  });

  test("an address the outbound check forbids is not dialled and the key goes nowhere", async () => {
    const t = setup({
      upstream: upstreamOf("openai", "gpt-5", "http://169.254.169.254/latest"),
    });
    const response = await t.post("responses", { input: "hi" });
    expect(response.status).toBe(502);
    expect(JSON.stringify(await bodyOf(response))).toContain("不允许访问");
    expect(t.seen).toHaveLength(0);
  });

  test("a redirect from the provider is not followed", async () => {
    const t = setup({
      script: () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        }),
    });
    const response = await t.post("responses", { input: "hi" });
    expect(response.status).toBe(502);
    expect(t.seen).toHaveLength(1);
  });

  test("a provider's own error is passed on, and the call is recorded without usage", async () => {
    const t = setup({
      script: () =>
        Response.json({ error: { message: "rate limited" } }, { status: 429 }),
    });
    const response = await t.post("responses", { input: "hi" });
    expect(response.status).toBe(429);
    expect(await bodyOf(response)).toEqual({
      error: { message: "rate limited" },
    });
    expect(t.rows[0]).toMatchObject({
      outcome: "unknown",
      usageStatus: "unknown",
      inputTokens: null,
    });
  });
});

describe("mounted on the server", () => {
  test("answers on /api/agent-model/v1 without a session, and lists the employee's model", async () => {
    const t = setup();
    const app = new Hono();
    mountAgentModelProxy(app, t.proxy);
    const headers = {
      authorization: `Bearer ${t.pass()}`,
      "content-type": "application/json",
    };
    const responses = await app.request("/api/agent-model/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({ input: "hi" }),
    });
    expect(responses.status).toBe(200);
    const messages = await app.request(
      "/api/agent-model/v1/messages?beta=true",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ messages: [] }),
      },
    );
    expect(messages.status).toBe(200);
    const models = await app.request("/api/agent-model/v1/models", { headers });
    expect(await models.json()).toMatchObject({
      object: "list",
      data: [{ id: "deepseek-chat" }],
    });
    const unsigned = await app.request("/api/agent-model/v1/models");
    expect(unsigned.status).toBe(401);
  });

  test("is not mounted when there is no proxy", async () => {
    const app = new Hono();
    mountAgentModelProxy(app, undefined);
    const response = await app.request("/api/agent-model/v1/responses", {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });
});

describe("what acp.open carries", () => {
  const tokens = createAgentModelTokens({ encryptionKey: KEY });
  const access = (
    bound: string | null | "throws",
    baseUrl: string | undefined,
  ) =>
    createAcpModelAccess({
      tokens,
      baseUrl,
      boundModel: async () => {
        if (bound === "throws") throw new Error("database down");
        return bound;
      },
    });
  const who = { tenantId: TENANT, agentId: AGENT, threadId: THREAD };

  test("Codex gets the Responses wire and Claude Code the Messages wire, with a pass for this employee", async () => {
    const base = "https://xiongbao.test/api/agent-model";
    const a = access("deepseek-chat", base);
    const codex = await a.issue({ ...who, harness: "codex" });
    expect(codex).toMatchObject({
      baseUrl: base,
      model: "deepseek-chat",
      wire: "responses",
    });
    expect(tokens.verify(codex?.token)).toMatchObject(who);
    expect(codex?.expiresAt).toBe(tokens.verify(codex?.token)?.expiresAt);
    const claude = await a.issue({ ...who, harness: "claude-code" });
    expect(claude?.wire).toBe("messages");
  });

  test("nothing for Hermes or the owner's own agent, an employee with no model, or a server nobody can reach", async () => {
    const base = "https://xiongbao.test/api/agent-model";
    expect(
      await access("m", base).issue({ ...who, harness: "hermes" }),
    ).toBeNull();
    expect(
      await access("m", base).issue({ ...who, harness: "custom" }),
    ).toBeNull();
    expect(
      await access(null, base).issue({ ...who, harness: "codex" }),
    ).toBeNull();
    expect(
      await access("m", undefined).issue({ ...who, harness: "codex" }),
    ).toBeNull();
    expect(
      await access("throws", base).issue({ ...who, harness: "codex" }),
    ).toBeNull();
  });

  test("the proxy's address and switches come from the environment", () => {
    const route = "/api/agent-model";
    const plain = readAgentModelProxyConfig({}, "https://a.test/", route);
    expect(plain as unknown).toEqual({
      enabled: true,
      baseUrl: "https://a.test/api/agent-model",
    });
    expect(plain.perMinute).toBeUndefined();
    expect(
      readAgentModelProxyConfig(
        {
          XIONGBAO_AGENT_MODEL_PUBLIC_URL: "https://edge.test",
          XIONGBAO_AGENT_MODEL_RATE_PER_MINUTE: "30",
        },
        "https://a.test",
        route,
      ),
    ).toEqual({
      enabled: true,
      baseUrl: "https://edge.test/api/agent-model",
      perMinute: 30,
    });
    expect(
      readAgentModelProxyConfig(
        { XIONGBAO_AGENT_MODEL_PROXY: "off" },
        "https://a.test",
        route,
      ),
    ).toMatchObject({ enabled: false, baseUrl: undefined });
    expect(
      readAgentModelProxyConfig({}, undefined, route).baseUrl,
    ).toBeUndefined();
    expect(
      readAgentModelProxyConfig({}, "not a url", route).baseUrl,
    ).toBeUndefined();
  });
});
