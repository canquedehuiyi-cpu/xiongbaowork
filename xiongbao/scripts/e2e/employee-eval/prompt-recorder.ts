/**
 * 提示词体积的记录器：一个只在回环地址上监听的转发服务，夹在熊宝服务器和模型提供方之间。
 *
 * 熊宝服务器调模型时，请求体（系统提示、工具定义、历史）只存在于这一次 HTTP 请求里，库里只留 token 计数。
 * 要知道每段提示词多大，就得在路上看一眼：把模型库条目的接口地址指向这里，这里把请求原样转给真正的提供方
 * （响应原样流回去，包括流式），顺手把请求体读成 {@link ChatRequest} 留在内存里，评测脚本在每道题前后取走。
 *
 * 只记请求体，不记请求头（key 在 `authorization` 里，原样转走，不落地也不打印）；响应不看。
 * 本机假模型模式下上游就是假模型，同一条链路照样跑。
 */

import type { ChatRequest } from "./token-breakdown";

export type PromptRecorder = {
  /** 熊宝服务器该用的接口地址：回环地址加上游地址里原有的路径前缀（例如 `/v1`）。 */
  url: string;
  /** 取走自上次以来记下的请求体（按到达顺序），并清空。 */
  drain: () => ChatRequest[];
  stop: () => void;
};

/** 不原样转给上游或不原样回给调用方的头：由各自的 HTTP 栈重新生成。 */
const HOP_BY_HOP = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "content-encoding",
];

/** `upstream` 是真正的接口地址（带不带 `/v1` 都行），例如 `https://api.deepseek.com`。 */
export function startPromptRecorder(upstream: string): PromptRecorder {
  const target = new URL(upstream);
  const prefix = target.pathname.replace(/\/+$/, "");
  let bodies: ChatRequest[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // 推理模型在出第一个字之前可能很久没动静：用 Bun 允许的最长空闲时间，别替提供方掐连接。
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (request.method === "POST" && bytes.length) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
          if (parsed && typeof parsed === "object")
            bodies.push(parsed as ChatRequest);
        } catch {}
      }
      const headers = new Headers(request.headers);
      for (const name of HOP_BY_HOP) headers.delete(name);
      try {
        const upstreamResponse = await fetch(
          `${target.origin}${url.pathname}${url.search}`,
          {
            method: request.method,
            headers,
            ...(bytes.length ? { body: bytes } : {}),
            redirect: "manual",
          },
        );
        const back = new Headers(upstreamResponse.headers);
        for (const name of HOP_BY_HOP) back.delete(name);
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: back,
        });
      } catch {
        return Response.json({ error: "上游不可达" }, { status: 502 });
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}${prefix}`,
    drain: () => {
      const taken = bodies;
      bodies = [];
      return taken;
    },
    stop: () => server.stop(true),
  };
}
