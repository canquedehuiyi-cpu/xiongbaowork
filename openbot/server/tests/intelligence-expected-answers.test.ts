import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { IntelligenceKnowingANewThread } from "@openbot/toolkit/copilotkit/agents";
import { createThreadReader } from "../src/channels/thread-status";
import { loadConfig } from "../src/config";
import { createIntelligenceClient } from "../src/intelligence-client";
import { testEnvironment } from "./support/environment";

/**
 * Kinks 23 and 25 of the Helm bundle build: expected answers printed as failures.
 *
 * Every new conversation printed two multi-line `Intelligence platform request failed` objects: the
 * browser opening it reads its history, and Learning asks whether its thread is new, before the
 * thread exists, and Intelligence answers both with the 404 a thread nobody has run yet is. And a
 * Bot's answer to another Bot that arrived while the asking Bot was still finishing printed the
 * 409 of its busy conversation, which the hop waits out by design. The runtime client prints every
 * answer outside 2xx (its logger is `console`) unless the method passed it as expected.
 *
 * Real: the runtime as copilot.ts mounts it, its Learning selector, the hop's history read and
 * lock, the thread reader the browser asks, all over HTTP. Faked: Intelligence, answering with its
 * own error envelope (`createErrorResponseBody`, apps/app-api/src/errors/registry.ts).
 */

const USER = "dev-local-user";

function envelope(code: string, message: string, retryable: boolean) {
  return {
    error: { code, message, category: "x", retryable },
    requestId: "request-test",
    traceId: "trace-test",
  };
}

/** Intelligence's thread routes: a thread exists once a run creates it, and one run holds its lock. */
function intelligence() {
  const threads = new Map<string, { id: string; name: null }>();
  const locks = new Map<string, string>();
  const broken = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const [, , , threadId, tail] = url.pathname.split("/");
      if (threadId && broken.has(threadId))
        return Response.json(
          envelope("INTERNAL_SERVER_ERROR", "Unexpected server error.", true),
          { status: 500 },
        );
      const missing = () =>
        Response.json(
          envelope("THREAD_NOT_FOUND", "Thread not found.", false),
          {
            status: 404,
          },
        );
      if (request.method === "POST" && url.pathname === "/api/threads") {
        const body = (await request.json()) as { threadId: string };
        const thread = { id: body.threadId, name: null };
        threads.set(body.threadId, thread);
        return Response.json({ thread }, { status: 201 });
      }
      if (!threadId) return new Response(null, { status: 404 });
      if (request.method === "GET" && tail === undefined) {
        const thread = threads.get(threadId);
        return thread ? Response.json({ thread }) : missing();
      }
      if (request.method === "GET" && tail === "messages") {
        return threads.has(threadId)
          ? Response.json({
              messages: [{ id: "m1", role: "user", content: "hi" }],
            })
          : missing();
      }
      if (request.method === "POST" && tail === "lock") {
        const body = (await request.json()) as { runId: string };
        if (!threads.has(threadId))
          threads.set(threadId, { id: threadId, name: null });
        if (locks.has(threadId))
          return Response.json(
            envelope(
              "THREAD_LOCK_FAILED",
              "Thread is already locked by another runner.",
              true,
            ),
            { status: 409 },
          );
        locks.set(threadId, body.runId);
        return Response.json({
          threadId,
          runId: body.runId,
          joinToken: "join",
          ttlSeconds: 120,
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    broken,
    /** The run holding a thread lets go, as the platform does once that run is over. */
    release: (threadId: string) => locks.delete(threadId),
    stop: () => server.stop(true),
  };
}

const platform = intelligence();
const telemetry = process.env.COPILOTKIT_TELEMETRY_DISABLED;
let printed: ReturnType<typeof spyOn<Console, "error">>;

beforeAll(() => {
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
});
afterEach(() => {
  printed?.mockRestore();
});
afterAll(() => {
  platform.stop();
  if (telemetry === undefined) delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
  else process.env.COPILOTKIT_TELEMETRY_DISABLED = telemetry;
});

const failedReads = () =>
  printed.mock.calls.filter((call) =>
    call.some(
      (part) =>
        typeof part === "string" &&
        part.includes("Intelligence platform request failed"),
    ),
  );

/** This deployment's Intelligence settings, pointed at the fake platform. */
function intelligenceSettings() {
  const config = loadConfig(
    testEnvironment({ INTELLIGENCE_API_URL: platform.url }),
  );
  if (!config.intelligence) throw new Error("Expected Intelligence settings.");
  return config.intelligence;
}

/*
 * M3: upstream's "a new conversation opens, is assigned to Learning and runs, and nothing is printed"
 * is not kept. It mounts the runtime on Intelligence's thread store and reads its Learning selector
 * (`copilot.learning`, `learningSettings`); the fork's runtime keeps its threads in the local runner
 * (R0) and builds Learning beside it in index.ts, so there is no such runtime to mount here.
 */

test("a real failure is still the client's to print, once, and still throws", async () => {
  printed = spyOn(console, "error").mockImplementation(() => {});
  const settings = intelligenceSettings();
  const threadId = crypto.randomUUID();
  platform.broken.add(threadId);
  const reader = createThreadReader(createIntelligenceClient(settings));
  await expect(reader(threadId, USER)).rejects.toMatchObject({
    name: "PlatformRequestError",
    status: 500,
  });
  expect(failedReads()).toHaveLength(1);
});

/**
 * The quiet requests are the client's own requests. A runtime upgrade that changes what its client
 * sends (a header, a lock field) fails here rather than leaving the quiet path sending the old one.
 */
test("asks exactly what the runtime client asks", async () => {
  printed = spyOn(console, "error").mockImplementation(() => {});
  const captured: Record<string, unknown>[] = [];
  const recorder = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const text = await request.text();
      captured.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
        delivery: request.headers.get("x-cpki-channel-delivery-id"),
        body: text ? JSON.parse(text) : null,
      });
      if (request.url.endsWith("/lock"))
        return Response.json({ threadId: "t", runId: "r", joinToken: "j" });
      if (request.url.includes("/messages"))
        return Response.json({ messages: [] });
      return Response.json({ thread: { id: "t", name: null } });
    },
  });
  try {
    const settings = {
      apiUrl: `http://127.0.0.1:${recorder.port}`,
      wsUrl: "ws://127.0.0.1:9",
      apiKey: "cpk-test-key",
    };
    const ask = async (client: CopilotKitIntelligence) => {
      await client.getThread({ threadId: "t 1", userId: "u/1" });
      await client.getThreadMessages({ threadId: "t 1", userId: "u/1" });
      await client.getThreadMessages({
        threadId: "t 1",
        userId: "u/1",
        channelDeliveryId: "delivery-1",
      });
      await client.ɵacquireThreadLock({
        threadId: "t 1",
        runId: "r",
        userId: "u/1",
        agentId: "a",
      });
      await client.ɵacquireThreadLock({
        threadId: "t 1",
        runId: "r",
        userId: "u/1",
        agentId: "a",
        supportsBackendThreadId: true,
        learningContainerId: "openbot",
        channelDeliveryId: "delivery-1",
        requestId: "request-1",
        lockKeyPrefix: "thread",
        ttlSeconds: 120,
      });
      return captured.splice(0);
    };
    const theirs = await ask(new CopilotKitIntelligence(settings));
    const ours = await ask(new IntelligenceKnowingANewThread(settings));
    expect(theirs).toHaveLength(5);
    expect(ours).toEqual(theirs);
  } finally {
    recorder.stop(true);
  }
});
