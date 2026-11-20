import { afterEach, expect, test } from "bun:test";
import { startPromptRecorder } from "./prompt-recorder";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** 一个假上游：把收到的路径、授权头和请求体原样记下，回一段分块的流。 */
function upstream() {
  const seen: { path: string; auth: string | null; body: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        body: await request.text(),
      });
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (const piece of [
              "data: one\n\n",
              "data: two\n\n",
              "data: [DONE]\n\n",
            ]) {
              controller.enqueue(encoder.encode(piece));
              await Bun.sleep(5);
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

test("requests are forwarded untouched, the stream comes back whole, and the body is kept", async () => {
  const far = upstream();
  const recorder = startPromptRecorder(`${far.url}/v1`);
  stops.push(recorder.stop);
  expect(recorder.url.endsWith("/v1")).toBe(true);

  const body = { messages: [{ role: "user", content: "你好" }], stream: true };
  const response = await fetch(`${recorder.url}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer not-a-real-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(
    "data: one\n\ndata: two\n\ndata: [DONE]\n\n",
  );

  // The recorder's address carries the upstream's own path prefix, so the path the server asks for is the
  // path the real provider gets.
  expect(far.seen[0]?.path).toBe("/v1/chat/completions");
  expect(far.seen).toHaveLength(1);
  expect(far.seen[0]?.auth).toBe("Bearer not-a-real-key");
  expect(JSON.parse(far.seen[0]?.body ?? "{}")).toEqual(body);

  expect(recorder.drain()).toEqual([body]);
  expect(recorder.drain()).toEqual([]);
});

test("an unreachable upstream is a 502, not a hang, and the key is never in what is kept", async () => {
  const recorder = startPromptRecorder("http://127.0.0.1:9");
  stops.push(recorder.stop);
  const response = await fetch(`${recorder.url}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer not-a-real-key" },
    body: JSON.stringify({ messages: [] }),
  });
  expect(response.status).toBe(502);
  expect(JSON.stringify(recorder.drain())).not.toContain("not-a-real-key");
});
