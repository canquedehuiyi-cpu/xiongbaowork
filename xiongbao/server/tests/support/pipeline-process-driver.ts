import { writeFile } from "node:fs/promises";
import { createDatabase } from "../../src/db/client";
import { createPipelineStore } from "../../src/pipeline/store";
import { createTaskProjector } from "../../src/tasks/projector";
import { TEST_POOL, testDatabaseUrl } from "./database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const calls: string[] = [];
const directory = process.env.AUDIT_GATE_DIR!;
const label = process.env.AUDIT_DRIVER!;
const store = createPipelineStore({
  database,
  board: createTaskProjector(database),
  canUse: async () => true,
  executeStep: async (input) => {
    calls.push(input.agentId);
    if (calls.length === 1) {
      await writeFile(`${directory}/${label}.entered`, input.stepRunRef);
      const deadline = Date.now() + 12000;
      while (!(await Bun.file(`${directory}/release`).exists())) {
        if (Date.now() >= deadline)
          throw new Error("Independent audit release deadline exceeded");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return { status: "done", output: "mock only; no provider" };
  },
});
try {
  const result = await store.advance({
    tenantId: process.env.AUDIT_TENANT_ID!,
    runId: process.env.AUDIT_RUN_ID!,
  });
  console.log(
    JSON.stringify({
      driver: label,
      pid: process.pid,
      status: result.status,
      calls,
      providerCalls: 0,
    }),
  );
} finally {
  await database.$client.close();
}
