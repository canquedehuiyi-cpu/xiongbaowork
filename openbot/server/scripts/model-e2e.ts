/**
 * Story G6 / audit defect #11: one minimal REAL call through a bound model, reconciled against the
 * `model_token_calls` row the metering wrote for it.
 *
 * Run only by `.github/workflows/model-e2e.yml`, by hand, inside the GitHub Environment `model-e2e`,
 * against that job's own throwaway Postgres. Nothing else may run it: it spends real tokens on a real
 * key, so it refuses unless `MODEL_E2E=1`, `GITHUB_ACTIONS=true` and `MODEL_E2E_API_KEY` are all set.
 * `ci.yml` does not reference it.
 *
 * The path is the product's, not a shortcut around it:
 *   1. one tenant is provisioned as the owner of every record below;
 *   2. the key goes into the vault through the credential store, encrypted, under that tenant;
 *   3. one model-library row points at it, and one coworker is bound to that row;
 *   4. `createAgentModelResolver` resolves the coworker, exactly as a run would, and the production
 *      metering sink writes the row;
 *   5. one `generateText` call (~5 prompt tokens, at most 16 out, no retries) runs inside
 *      `withModelRun`, so the row carries this run's id;
 *   6. the row is read back AS THAT TENANT (row-level security decides what is visible) and reconciled
 *      against the usage the provider reported on the wire (the raw response body), falling back to
 *      the SDK's figures only when there is no body to read.
 *
 * Prints counts and identifiers only: never the key, the ciphertext, the prompt's answer or any
 * provider error body. Exits non-zero on any mismatch.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { defer, firstValueFrom } from "rxjs";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  modelRegistry,
  modelTokenCalls,
  users,
} from "../src/db/schema";
import {
  type ProviderUsage,
  type ReconcileResult,
  reconcile,
  wireUsage,
} from "../src/models/metering-reconcile";
import { createAgentModelResolver } from "../src/models/runtime-resolver";
import {
  databaseTokenCallSink,
  type ModelTokenCallSink,
  withModelRun,
} from "../src/models/token-metering";
import { runAsTenant } from "../src/tenant/context";

export type HarnessConfig = {
  databaseUrl: string;
  provider: string;
  modelName: string;
  baseUrl: string | null;
  apiKey: string;
};

export type HarnessGate =
  | { ok: true; config: HarnessConfig }
  | { ok: false; reason: string };

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Whether this process may spend a real key, and with what. The reasons name variables, never
 * their values.
 */
export function harnessGate(
  env: Record<string, string | undefined>,
): HarnessGate {
  if (env.MODEL_E2E !== "1")
    return { ok: false, reason: "MODEL_E2E=1 is not set" };
  if (env.GITHUB_ACTIONS !== "true")
    return { ok: false, reason: "not running inside GitHub Actions" };
  const apiKey = env.MODEL_E2E_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: "MODEL_E2E_API_KEY is not set" };
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) return { ok: false, reason: "DATABASE_URL is not set" };
  const provider = env.MODEL_E2E_PROVIDER?.trim() ?? "";
  if (!PROVIDER_PATTERN.test(provider))
    return {
      ok: false,
      reason: "MODEL_E2E_PROVIDER is not set to a provider template id",
    };
  const modelName = env.MODEL_E2E_MODEL?.trim();
  if (!modelName) return { ok: false, reason: "MODEL_E2E_MODEL is not set" };
  const rawBaseUrl = env.MODEL_E2E_BASE_URL?.trim() || null;
  if (rawBaseUrl !== null) {
    let protocol = "";
    try {
      protocol = new URL(rawBaseUrl).protocol;
    } catch {
      protocol = "";
    }
    if (protocol !== "https:")
      return { ok: false, reason: "MODEL_E2E_BASE_URL must be an https URL" };
  }
  return {
    ok: true,
    config: { databaseUrl, provider, modelName, baseUrl: rawBaseUrl, apiKey },
  };
}

function countCell(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "null";
}

export function summaryMarkdown(input: {
  originalText: string;
  usageStatus: string | null;
  rowInput: number | null;
  rowOutput: number | null;
  providerUsage: ProviderUsage;
  /** `wire`: read from the provider's response body; `sdk`: the SDK's figures, no body to read. */
  usageSource: "wire" | "sdk";
  callError: string | null;
  result: ReconcileResult;
}): string {
  const lines = [
    "## 模型 E2E 计量对账（G6 / 缺陷 #11）",
    "",
    `- 模型：\`${input.originalText}\``,
    `- 结果：${input.result.ok ? "通过" : "不一致"}`,
    `- usage_status：\`${input.usageStatus ?? "无记录"}\``,
    `- 供应商用量来源：${input.usageSource === "wire" ? "响应体原始 usage" : "SDK 换算（无响应体）"}`,
    "",
    "| | 输入 tokens | 输出 tokens |",
    "| --- | --- | --- |",
    `| 供应商报告 | ${countCell(input.providerUsage.inputTokens)} | ${countCell(input.providerUsage.outputTokens)} |`,
    `| model_token_calls | ${countCell(input.rowInput)} | ${countCell(input.rowOutput)} |`,
  ];
  if (input.callError) lines.push("", `- 调用失败：\`${input.callError}\``);
  if (input.result.mismatches.length > 0) {
    lines.push("", "| 字段 | 期望 | 实际 |", "| --- | --- | --- |");
    for (const m of input.result.mismatches)
      lines.push(
        `| ${m.field} | ${String(m.expected)} | ${String(m.actual)} |`,
      );
  }
  return `${lines.join("\n")}\n`;
}

async function main(config: HarnessConfig): Promise<boolean> {
  // A fresh database per job, so a fresh vault key per run: nothing outlives the job.
  const encryptionKey = randomBytes(32).toString("base64");
  const database = createDatabase(config.databaseUrl, { max: 4 });
  const credentialStore = createCredentialStore(database);
  const tenant = `model-e2e-${randomUUID()}`;
  const agentId = `${tenant}-agent`;
  const runId = `model-e2e-run-${randomUUID()}`;
  const originalText = `${config.provider}/${config.modelName}`;

  try {
    // 1-3. The tenant owns the person, the vault row, the library row and the coworker.
    const binding = await runAsTenant(tenant, async () => {
      await database
        .insert(users)
        .values({ id: tenant, email: `${tenant}@model-e2e.invalid` });
      const credential = await credentialStore.create({
        kind: "model",
        provider: config.provider,
        keyId: `${tenant}-${config.modelName}`,
        encryptedValue: await encryptSecret(encryptionKey, config.apiKey),
        metadata: {},
      });
      const [entry] = await database
        .insert(modelRegistry)
        .values({
          provider: config.provider,
          baseUrl: config.baseUrl,
          modelName: config.modelName,
          credentialId: credential.id,
          label: "model-e2e",
        })
        .returning({ id: modelRegistry.id, tenantId: modelRegistry.tenantId });
      if (!entry) throw new Error("model_registry row was not created");
      await database.insert(agents).values({
        id: agentId,
        name: agentId,
        type: "built_in",
        configuration: { systemPrompt: "model-e2e" },
      });
      await database.insert(agentProfiles).values({
        agentId,
        ownerUserId: tenant,
        title: "模型 E2E",
        roleDescription: "模型计量对账",
        avatarSeed: tenant,
        visibility: "private",
        modelRef: entry.id,
      });
      return entry;
    });
    // The tenant the run is checked against is the one stamped on the claimed library row.
    if (binding.tenantId !== tenant)
      throw new Error("model_registry row was stamped with another tenant");

    // 4. The production sink, with its write awaited before the row is read back.
    const productionSink = databaseTokenCallSink(database);
    const writes: Promise<void>[] = [];
    const sink: ModelTokenCallSink = (row) => {
      const written = productionSink(row);
      writes.push(written);
      return written;
    };
    const resolve = createAgentModelResolver(
      database,
      credentialStore,
      encryptionKey,
      sink,
    );
    const model = await runAsTenant(tenant, () => resolve(agentId));
    if (!model)
      throw new Error("the bound coworker did not resolve to a model");

    // 5. One minimal call, inside the run's scope.
    let providerUsage: ProviderUsage = {};
    let usageSource: "wire" | "sdk" = "sdk";
    let callError: string | null = null;
    try {
      const result = await firstValueFrom(
        withModelRun(
          { runId, threadId: runId },
          defer(() =>
            generateText({
              model,
              prompt: "Reply with OK.",
              maxOutputTokens: 16,
              maxRetries: 0,
            }),
          ),
        ),
      );
      // What the provider put on the wire, not the SDK's conversion of it: the SDK turns a missing
      // count into 0 for some providers, and so would agree with a row that did the same. The body
      // itself is never printed.
      const wire = wireUsage(result.response.body);
      usageSource = wire ? "wire" : "sdk";
      providerUsage = wire ?? {
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
      };
    } catch (error) {
      // The name only: a provider error's message can quote the request or the response body.
      callError = error instanceof Error ? error.name : "unknown";
    }
    await Promise.all(writes);

    // 6. Read back as the tenant; RLS decides what is visible.
    const rows = await runAsTenant(tenant, () =>
      database
        .select()
        .from(modelTokenCalls)
        .where(eq(modelTokenCalls.runId, runId)),
    );
    const row = rows[0];
    const result: ReconcileResult = row
      ? reconcile(row, providerUsage, {
          tenantId: binding.tenantId,
          modelRef: binding.id,
          originalText,
          agentId,
        })
      : { ok: false, mismatches: [] };
    if (rows.length !== 1)
      result.mismatches.push({
        field: "rowCount",
        expected: 1,
        actual: rows.length,
      });
    if (callError)
      result.mismatches.push({
        field: "call",
        expected: "completed",
        actual: callError,
      });
    result.ok = result.mismatches.length === 0;

    const summary = summaryMarkdown({
      originalText,
      usageStatus: row?.usageStatus ?? null,
      rowInput: row?.inputTokens ?? null,
      rowOutput: row?.outputTokens ?? null,
      providerUsage,
      usageSource,
      callError,
      result,
    });
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) await appendFile(summaryPath, summary);
    console.info(
      JSON.stringify({
        type: "model-e2e",
        ok: result.ok,
        usageStatus: row?.usageStatus ?? null,
        provider: providerUsage,
        usageSource,
        row: {
          inputTokens: row?.inputTokens ?? null,
          outputTokens: row?.outputTokens ?? null,
        },
        mismatches: result.mismatches,
      }),
    );
    return result.ok;
  } finally {
    await database.$client.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const gate = harnessGate(process.env);
  if (!gate.ok) {
    console.error(`model-e2e refused: ${gate.reason}`);
    process.exit(2);
  }
  // Nothing downstream needs the plaintext in the environment once it is held here.
  delete process.env.MODEL_E2E_API_KEY;
  try {
    const ok = await main(gate.config);
    process.exit(ok ? 0 : 1);
  } catch (error) {
    // The name only: database and provider errors can carry connection details or row contents.
    console.error(
      `model-e2e failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
    process.exit(1);
  }
}
