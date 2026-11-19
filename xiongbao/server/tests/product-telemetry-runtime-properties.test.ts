import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/client";
import { type LambdaSendOptions, lambdaClient } from "@copilotkit/shared";
import { inArray, like } from "drizzle-orm";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, registeredAgentFromRow } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { threadRuns, threads } from "../src/db/schema";
import { createProductTelemetry } from "../src/telemetry/product";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * CopilotKit's own runtime events, not OpenBot's product events, are silenced unconditionally
 * (see runtime-telemetry.ts): whether product telemetry is off or on, none is handed to the runtime's
 * telemetry transport.
 *
 * Through the real runtime: the handler `mountCopilotRuntime` returns, answering a run request.
 * What the runtime hands its telemetry transport is captured in place of the network send,
 * so nothing leaves this machine. The Intelligence platform is a fake on 127.0.0.1 that refuses
 * everything; the event is recorded before the run reaches it.
 */

const captured: LambdaSendOptions[] = [];
/**
 * M3: the fork keeps a person's threads in its own database and refuses to mount the runtime without
 * that runner (`localRunnerOrRefused` in copilot.ts), so the runs here go through it.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
/** The threads the runs below started, cleared once each run is stored. */
const started: string[] = [];
const transport = lambdaClient.send;
const disabled = {
  COPILOTKIT_TELEMETRY_DISABLED: process.env.COPILOTKIT_TELEMETRY_DISABLED,
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
};
let platform: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  // The runtime records its events only where its own telemetry is not switched off.
  delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
  lambdaClient.send = async (event) => {
    captured.push(event);
  };
  platform = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ error: "unavailable" }, { status: 503 }),
  });
});

afterAll(async () => {
  await runAsTenant("platform", async () => {
    // Each run is stored after its stream ends: cleared only once it is, or the store trips on it.
    const deadline = Date.now() + 10_000;
    while (
      started.length > 0 &&
      (
        await database
          .select({ id: threadRuns.id })
          .from(threadRuns)
          .where(inArray(threadRuns.threadId, started))
      ).length < started.length &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    await database.delete(threads).where(like(threads.id, `thread-%-${suite}`));
  });
  await database.$client.close();
  lambdaClient.send = transport;
  platform.stop(true);
  for (const [name, value] of Object.entries(disabled))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

/** Every event the runtime handed its telemetry transport during one run request of a deployment. */
async function runtimeEventsDuring(
  deploymentId: string,
  productEnv: Record<string, string>,
) {
  const productTelemetry = await createProductTelemetry({
    privacyKey: "synthetic-privacy-key",
    deploymentId,
    env: productEnv,
    send: async () => {},
  });
  const bot = registeredAgentFromRow({
    id: "standup",
    name: "Standup",
    type: "remote_ag_ui",
    configuration: { endpoint: `http://127.0.0.1:${platform.port}/ag-ui` },
    title: "Standup Bot",
    roleDescription: "Write the standup.",
  });
  if (!bot) throw new Error("the Bot did not parse");
  const runtime = mountCopilotRuntime(
    loadConfig(
      testEnvironment({
        INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
        INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
      }),
    ),
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "unused" },
      loadAgents: async () => [bot],
      resolveModelApiKey: async () => null,
    }),
    async () => ({ id: "colleague", name: "Colleague" }),
    async () => ({ id: "colleague", role: "user" }),
    { productTelemetry, localRunner: new PostgresAgentRunner(database) },
  );
  const before = captured.length;
  started.push(`thread-${deploymentId}-${suite}`);
  const response = await runtime.handler.fetch(
    new Request("http://127.0.0.1/api/copilotkit/agent/standup/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: `thread-${deploymentId}-${suite}`,
        runId: `run-${deploymentId}`,
        state: {},
        messages: [{ id: "ask-1", role: "user", content: "Hello." }],
        tools: [],
        context: [],
        forwardedProps: {},
      } satisfies RunAgentInput),
    }),
  );
  // Read to its end, so the run is over (and stored) before the next begins.
  await response.text();
  // The runtime records its events while the run is handled, so a short grace period after the
  // stream ends is enough; a bounded wait keeps the "nothing was sent" check from hanging.
  await Bun.sleep(300);
  return captured.slice(before);
}

test("with product telemetry off, no event reaches the runtime's telemetry transport", async () => {
  expect(await runtimeEventsDuring("dep_telemetry_off", {})).toEqual([]);
});

// User decision 2026-11-12: our deliverables send no usage data to any third party, so product
// telemetry being on does not reopen the runtime's own reports (runtime-telemetry.ts).
test("with product telemetry on, still no event reaches the runtime's telemetry transport", async () => {
  expect(
    await runtimeEventsDuring("dep_telemetry_on", {
      OPENBOT_PRODUCT_TELEMETRY: "1",
    }),
  ).toEqual([]);
});
