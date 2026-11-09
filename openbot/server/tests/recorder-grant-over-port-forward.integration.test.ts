// The Recorder's capture pass on an OpenBot whose only address is a `kubectl port-forward`.
//
// The Helm chart that installs Intelligence beside OpenBot turns INTELLIGENCE_GATEWAY_PROXY on, so
// the gateway's client socket is reached through OpenBot's own address, and a vanilla install has no
// public URL: the person opens it at http://127.0.0.1:<port> over a port-forward, single-user. The page
// is told the socket as a path and resolves it against itself. The Recorder is not on the page, and
// was handed the same path in its capture pass, which the runtime refuses as no URL at all: every
// recording failed with a 502.
//
// Real paths: the real HTTP server, the app with the runtime and the Recorder's wiring mounted as
// index.ts mounts them, a real database, and one real server standing in for Intelligence, answering
// its trajectory join over HTTP and its gateway's `/client/websocket` as a socket.
import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ExchangeResponse,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq } from "drizzle-orm";
import { reservePort } from "../../tests/support/reserved-port";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { AgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { initializeDevActorUser } from "../src/auth/dev-actor";
import type { RoleRepository } from "../src/auth/guards";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  recorderConnections,
  recorderTrajectoryBindings,
} from "../src/db/schema/recorder";
import { startHttpServer } from "../src/http-server";
import { personalLearningContainerId } from "../src/learning/personal-space";
import { createRecorderExtension } from "../src/recorder/wiring";
import { createRequestActor } from "../src/request-actor";
import { ownOriginOnThisMachine } from "../src/request-trust";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { afterAll } from "./support/platform-frame";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const RECORDER_ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const INSTALL_ID = "e".repeat(32);

/** What the stand-in for Intelligence was asked: its trajectory joins, and the sockets opened on its gateway. */
const joins: Array<{ trajectoryId: string; appUserId: string }> = [];
const gatewaySockets: Array<{ path: string; search: string }> = [];
const gatewayHeard: string[] = [];

let intelligence: ReturnType<typeof Bun.serve>;
let openbot: { stop(closeActiveConnections?: boolean): Promise<void> };
let port: number;
let token: string;
const trajectories: string[] = [];
const guard = createStallGuard({ stallMs: 0 });

beforeAll(async () => {
  const intelligencePort = await reservePort();
  intelligence = Bun.serve({
    port: intelligencePort,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/client/websocket") {
        gatewaySockets.push({ path: url.pathname, search: url.search });
        if (server.upgrade(request, { data: undefined })) return undefined;
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      // What the runtime asks before it answers the page's `/info`.
      if (url.pathname === "/api/entitlements/runtime")
        return Response.json({ status: "valid" });
      if (url.pathname === "/api/trajectories/join") {
        const body = (await request.json()) as (typeof joins)[number];
        joins.push(body);
        return Response.json({
          joinToken: `join-${joins.length}`,
          trajectoryId: body.trajectoryId,
        });
      }
      return Response.json(
        { error: { code: "ROUTE_NOT_FOUND" } },
        { status: 404 },
      );
    },
    websocket: {
      message(ws, message) {
        gatewayHeard.push(String(message));
        ws.send(message);
      },
    },
  });

  port = await reservePort();
  // As the chart writes it for a bundled Intelligence: in a container, single-user, the gateway
  // carried by OpenBot, and no public URL anywhere.
  const config = loadConfig({
    DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    INTELLIGENCE_API_URL: `http://127.0.0.1:${intelligencePort}`,
    INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${intelligencePort}`,
    INTELLIGENCE_API_KEY: "tenant-api-key",
    COPILOTKIT_LICENSE_TOKEN: "license-token",
    OPENBOT_SINGLE_USER: "true",
    OPENBOT_IN_CONTAINER: "true",
    INTELLIGENCE_GATEWAY_PROXY: "on",
  });
  expect(config.singleUser).toBe(true);
  expect(config.publicUrl).toBeUndefined();
  // M3: the fork's config has no `runtime.intelligence.browserGatewayWsUrl` (its Intelligence is optional and
  // INTELLIGENCE_GATEWAY_PROXY is not read), so the page's socket address is not asserted on the config here.

  const auditStore = { insert: async (_event: AuditEventInput) => {} };
  const roleRepository: RoleRepository = {
    rolesForUser: async () => ["admin"],
  };
  const recorder = createRecorderExtension({
    config,
    database,
    organizationAuth: undefined,
    roleRepository,
    peopleStore: { isRevoked: async () => false },
    personalSpaces: {
      containerFor: personalLearningContainerId,
      state: async (userId) => ({
        state: "assigned",
        containerId: personalLearningContainerId(userId),
      }),
      kick: () => {},
    },
    auditStore,
  });
  const { identifyUser, identifyActor, resolveRequestActor } =
    createRequestActor({
      singleUser: true,
      resolveRecorder: recorder.resolve,
      getSession: async () => null,
      rolesForUser: (id) => roleRepository.rolesForUser(id),
    });
  const runtime = mountCopilotRuntime(
    config,
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "unused" },
      // The page's `/info` names the Bots there are, and answers nothing without one.
      loadAgents: async () => [
        { id: "notes", name: "Notes", type: "built_in", systemPrompt: "Work." },
      ],
      resolveModelApiKey: async () => "synthetic-key",
      stallGuard: guard,
    }),
    identifyUser,
    identifyActor,
    // M3: the fork refuses to mount the runtime without its own thread runner (copilot.ts).
    {
      trajectoryCapture: recorder.trajectoryCapture,
      localRunner: new PostgresAgentRunner(database),
    },
  );
  /*
   * createApp is positional. Placed by index rather than after a spread of `undefined`s, whose length
   * TypeScript cannot see, so each dependency is type-checked against the parameter it lands on.
   */
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = config;
  args[2] = roleRepository;
  args[6] = runtime.handler;
  args[12] = auditStore;
  // M3: the fork's createApp takes `coworker` at 33 (upstream's `learning` comes later here).
  args[33] = { recorder };
  openbot = startHttpServer({
    port,
    config,
    resolveRequestActor,
    agentProfileStore: {} as AgentProfileStore,
    computerGateway: undefined,
    app: createApp(...args),
  });

  await initializeDevActorUser(database, true);
  // Connected as the person connects it: a code minted on OpenBot's page, exchanged by the Recorder.
  const minted = await fetch(
    `http://127.0.0.1:${port}${recorderPaths.connectCodes}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ via: "web" }),
    },
  );
  expect(minted.status).toBe(201);
  const { code } = (await minted.json()) as { code: string };
  const exchanged = await fetch(
    `http://127.0.0.1:${port}${recorderPaths.connections}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: RECORDER_ORIGIN,
      },
      body: JSON.stringify({
        code,
        label: "Chrome on macOS",
        installId: INSTALL_ID,
      }),
    },
  );
  expect(exchanged.status).toBe(201);
  token = ((await exchanged.json()) as ExchangeResponse).token;
});

afterAll(async () => {
  await openbot?.stop(true);
  intelligence?.stop(true);
  guard.stop();
  for (const trajectoryId of trajectories)
    await database
      .delete(recorderTrajectoryBindings)
      .where(eq(recorderTrajectoryBindings.trajectoryId, trajectoryId));
  await database
    .delete(recorderConnections)
    .where(eq(recorderConnections.installId, INSTALL_ID));
  await database.$client.close();
});

/** The capture pass exactly as the Recorder asks for it, at the address it was connected to. */
function pass(headers: Record<string, string> = {}) {
  const trajectoryId = randomUUID();
  trajectories.push(trajectoryId);
  return fetch(
    `http://127.0.0.1:${port}${recorderPaths.trajectoryConnect(trajectoryId)}`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: RECORDER_ORIGIN,
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: "{}",
    },
  );
}

describe("the Recorder's capture pass over a port-forward, with no public URL", () => {
  // M3: "names the gateway socket as a whole address on OpenBot" and "that address carries the
  // Recorder's socket through to the gateway" are not kept: they need the Intelligence gateway proxy
  // (INTELLIGENCE_GATEWAY_PROXY) and a runtime on Intelligence, which the fork does not adopt (its
  // runtime runs on its own thread runner, so the capture pass answers INTELLIGENCE_RUNTIME_REQUIRED).
  test("never makes the address out of a name this machine does not answer to", async () => {
    const answer = await pass({ host: "openbot.attacker.example" });

    expect(answer.status).not.toBe(200);
    expect(await answer.text()).not.toContain("attacker");
  });

  // M3: "leaves the page's address a path" is not kept: the page's socket path comes from the
  // Intelligence gateway proxy, which the fork does not adopt.
});

describe("OpenBot's own origin, as a caller on this machine reached it", () => {
  const singleUser = {
    singleUser: true,
    singleUserAccess: { thisMachineOnly: false, hosts: [] },
  };
  const request = (host: string) =>
    new Request(`http://${host}/api/copilotkit/trajectory/x/connect`, {
      headers: { host },
    });

  test("is the Host a loopback caller named, when it is one of this machine's own names", () => {
    for (const [address, host, origin] of [
      // A port-forward's connection, as the pod sees it.
      ["127.0.0.1", "127.0.0.1:3101", "http://127.0.0.1:3101"],
      ["::1", "[::1]:3101", "http://[::1]:3101"],
      // A dual-stack socket's report of an IPv4 loopback peer.
      ["::ffff:127.0.0.1", "127.0.0.1:3001", "http://127.0.0.1:3001"],
      ["127.0.0.1", "localhost:3001", "http://localhost:3001"],
    ] as const) {
      expect(
        ownOriginOnThisMachine(request(host), { address }, singleUser),
      ).toBe(origin);
    }
  });

  test("is nothing for a caller on another machine, whatever Host it sends", () => {
    for (const address of ["10.0.12.7", "192.168.1.20", "2001:db8::7"]) {
      for (const host of ["127.0.0.1:3101", "10.0.0.5:3001", "openbot.test"])
        expect(
          ownOriginOnThisMachine(request(host), { address }, singleUser),
        ).toBeNull();
    }
  });

  test("is nothing for a name this machine does not answer to, or a caller nobody can name", () => {
    for (const host of [
      "openbot.attacker.example",
      "127.0.0.1.attacker.example",
      "10.0.0.5:3001",
    ])
      expect(
        ownOriginOnThisMachine(
          request(host),
          { address: "127.0.0.1" },
          singleUser,
        ),
      ).toBeNull();
    expect(
      ownOriginOnThisMachine(
        request("127.0.0.1:3101"),
        { address: null },
        singleUser,
      ),
    ).toBeNull();
    expect(
      ownOriginOnThisMachine(request("127.0.0.1:3101"), undefined, singleUser),
    ).toBeNull();
  });
});
