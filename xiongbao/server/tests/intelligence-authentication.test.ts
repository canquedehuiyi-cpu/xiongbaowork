import { afterEach, describe, expect, test } from "bun:test";
import { createIntelligenceClient } from "../src/intelligence-client";

const servers: ReturnType<typeof Bun.serve>[] = [];

function platform() {
  let status = 401;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(
        status === 200
          ? // `joinCode` is required by `ListThreadsResponse` and the platform always sends one: it
            // is what the realtime subscription for these threads is opened with. A fixture that
            // omitted it was answering an envelope no platform produces.
            {
              threads: [],
              nextCursor: null,
              joinCode: "fixture-join-code",
            }
          : { error: "fixture rejection" },
        { status },
      ),
  });
  servers.push(server);
  const client = createIntelligenceClient({
    apiUrl: server.url.origin,
    gatewayWsUrl: "ws://127.0.0.1:1",
    apiKey: "fixture-project-key",
  });
  return {
    client,
    respondWith(value: number) {
      status = value;
    },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

describe("Intelligence authentication recovery", () => {
  test("real SDK HTTP 401 reaches the caller as the SDK's own error", async () => {
    const { client } = platform();
    await expect(
      client.listThreads({ userId: "employee", agentId: "bot" }),
    ).rejects.toMatchObject({
      name: "PlatformRequestError",
      status: 401,
    });
  });

  test("permission and service failures reach the caller with their own status", async () => {
    const { client, respondWith } = platform();
    for (const status of [403, 404, 429, 500]) {
      respondWith(status);
      await expect(
        client.listThreads({ userId: "employee", agentId: "bot" }),
      ).rejects.toMatchObject({ status });
    }
  });

  test("a call that failed with 401 answers normally once the platform accepts the key", async () => {
    const { client, respondWith } = platform();
    await expect(
      client.listThreads({ userId: "employee", agentId: "bot" }),
    ).rejects.toMatchObject({ status: 401 });
    respondWith(200);
    expect(
      await client.listThreads({ userId: "employee", agentId: "bot" }),
    ).toEqual({
      threads: [],
      nextCursor: null,
      joinCode: "fixture-join-code",
    });
  });

  test("observed methods retain the SDK private-field receiver and lifecycle callbacks", async () => {
    const { client, respondWith } = platform();
    respondWith(200);
    expect(client.ɵgetApiKey()).toBe("fixture-project-key");
    expect(client.ɵgetRunnerWsUrl()).toContain("127.0.0.1:1");
    const unsubscribe = client.onThreadCreated(() => {});
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
    const read = client.listThreads.bind(client);
    expect(await read({ userId: "employee", agentId: "bot" })).toEqual({
      threads: [],
      nextCursor: null,
      joinCode: "fixture-join-code",
    });
  });
});
