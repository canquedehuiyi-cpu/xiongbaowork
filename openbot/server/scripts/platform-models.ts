/**
 * The operator's hand on the platform model pool (stories H1, K1): list, add and disable the
 * experience models every plan's coworkers may speak with before a tenant connects a key of its own.
 *
 *   bun scripts/platform-models.ts list
 *   bun scripts/platform-models.ts add --provider openai --model gpt-6-mini --label "体验模型" \
 *     --api-key-env OPENBOT_POOL_OPENAI [--base-url https://…] [--tiers free,pro]
 *   bun scripts/platform-models.ts disable <id>
 *
 * THE KEY IS NEVER AN ARGUMENT. `--api-key-env` takes the NAME of a deployment environment variable
 * (OPENBOT_POOL_*), and the server reads the value from its own environment when a coworker speaks.
 * A key typed on a command line lands in shell history and in `ps`; this refuses `--api-key` and
 * anything else it does not know rather than quietly ignoring it.
 *
 * Needs DATABASE_URL naming the database OWNER. Migration 0120 gives the application role SELECT
 * alone on `platform_model_pool`, so the server's own connection is refused here, by design. Rows
 * are disabled, never deleted: a row a coworker is still bound to cannot be deleted (0120's
 * restricted foreign key), and disabling sends those coworkers back to the deployment default.
 */
import { asc, eq } from "drizzle-orm";
import type { Database } from "../src/db/client";
import { createDatabase } from "../src/db/client";
import {
  PLATFORM_POOL_KEY_ENV,
  PLATFORM_POOL_TIERS,
  type PlatformPoolTier,
  platformModelPool,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";

export type PlatformModelsCommand =
  | { kind: "list" }
  | {
      kind: "add";
      provider: string;
      modelName: string;
      label: string;
      apiKeyEnv: string;
      baseUrl: string | null;
      tiers: PlatformPoolTier[];
    }
  | { kind: "disable"; id: string };

const USAGE = [
  "Usage:",
  "  bun scripts/platform-models.ts list",
  "  bun scripts/platform-models.ts add --provider P --model M --label L --api-key-env OPENBOT_POOL_NAME [--base-url URL] [--tiers free,pro]",
  "  bun scripts/platform-models.ts disable <id>",
].join("\n");

const ADD_FLAGS = new Set([
  "--provider",
  "--model",
  "--label",
  "--api-key-env",
  "--base-url",
  "--tiers",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The command, or the sentence about why it was refused. Pure, so the refusals are testable without
 * a database. An error never repeats a flag's value: the one a person might mistype is a key.
 */
export function parsePlatformModelsCommand(
  argv: readonly string[],
): PlatformModelsCommand | { error: string } {
  const [command, ...rest] = argv;
  if (command === "list") {
    return rest.length === 0 ? { kind: "list" } : { error: USAGE };
  }
  if (command === "disable") {
    const [id, ...extra] = rest;
    if (!id || extra.length > 0 || !UUID.test(id)) return { error: USAGE };
    return { kind: "disable", id };
  }
  if (command !== "add") return { error: USAGE };

  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index] ?? "";
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    if (!ADD_FLAGS.has(flag)) {
      // Named without its value: `--api-key=sk-…` must not be echoed back into a terminal log.
      return {
        error: `Unknown option ${flag.startsWith("--") ? flag : "(positional)"}. The key is never an argument: pass --api-key-env with the NAME of an OPENBOT_POOL_* variable.`,
      };
    }
    let value: string | undefined;
    if (equals > 0) {
      value = raw.slice(equals + 1);
    } else {
      value = rest[index + 1];
      index += 1;
    }
    if (value === undefined || value.trim() === "") {
      return { error: `${flag} needs a value.` };
    }
    if (values.has(flag)) return { error: `${flag} was given twice.` };
    values.set(flag, value.trim());
  }

  const provider = values.get("--provider");
  const modelName = values.get("--model");
  const label = values.get("--label");
  const apiKeyEnv = values.get("--api-key-env");
  if (!provider || !modelName || !label || !apiKeyEnv) {
    return {
      error: `add needs --provider, --model, --label and --api-key-env.\n${USAGE}`,
    };
  }
  if (!PLATFORM_POOL_KEY_ENV.test(apiKeyEnv)) {
    return {
      error:
        "--api-key-env must be the NAME of a variable matching OPENBOT_POOL_[A-Z0-9_]{1,64}, not a key.",
    };
  }
  const baseUrl = values.get("--base-url") ?? null;
  if (baseUrl !== null) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return { error: "--base-url must be an absolute https URL." };
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return {
        error: "--base-url must be an https URL with no credentials in it.",
      };
    }
  }
  const tierText = values.get("--tiers") ?? "free,pro";
  const tiers = [
    ...new Set(tierText.split(",").map((tier) => tier.trim())),
  ].filter(Boolean);
  const known = PLATFORM_POOL_TIERS as readonly string[];
  if (tiers.length === 0 || tiers.some((tier) => !known.includes(tier))) {
    return { error: `--tiers takes a comma list of ${known.join(", ")}.` };
  }
  return {
    kind: "add",
    provider,
    modelName,
    label,
    apiKeyEnv,
    baseUrl,
    tiers: tiers as PlatformPoolTier[],
  };
}

/** What `list` prints: the variable's name and whether this shell has it, never its value. */
export type PlatformModelListing = {
  id: string;
  provider: string;
  modelName: string;
  label: string;
  baseUrl: string | null;
  apiKeyEnv: string;
  tiers: string[];
  enabled: boolean;
};

/**
 * Runs one parsed command against an owner connection. Platform rows, so the platform frame; the
 * table has no tenant column and no row-level security, so the frame only keeps the session honest.
 */
export async function runPlatformModelsCommand(
  database: Database,
  command: PlatformModelsCommand,
): Promise<
  | { kind: "list"; models: PlatformModelListing[] }
  | { kind: "added"; id: string }
  | { kind: "disabled"; id: string }
  | { kind: "missing"; id: string }
> {
  if (command.kind === "list") {
    const models = await runAsTenant("platform", () =>
      database
        .select({
          id: platformModelPool.id,
          provider: platformModelPool.provider,
          modelName: platformModelPool.modelName,
          label: platformModelPool.label,
          baseUrl: platformModelPool.baseUrl,
          apiKeyEnv: platformModelPool.apiKeyEnv,
          tiers: platformModelPool.tiers,
          enabled: platformModelPool.enabled,
        })
        .from(platformModelPool)
        .orderBy(asc(platformModelPool.provider), asc(platformModelPool.label)),
    );
    return { kind: "list", models };
  }
  if (command.kind === "add") {
    const [row] = await runAsTenant("platform", () =>
      database
        .insert(platformModelPool)
        .values({
          provider: command.provider,
          modelName: command.modelName,
          label: command.label,
          apiKeyEnv: command.apiKeyEnv,
          baseUrl: command.baseUrl,
          tiers: command.tiers,
        })
        .returning({ id: platformModelPool.id }),
    );
    if (!row) throw new Error("The pool row was not written.");
    return { kind: "added", id: row.id };
  }
  const [row] = await runAsTenant("platform", () =>
    database
      .update(platformModelPool)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(platformModelPool.id, command.id))
      .returning({ id: platformModelPool.id }),
  );
  return row
    ? { kind: "disabled", id: row.id }
    : { kind: "missing", id: command.id };
}

if (import.meta.main) {
  const command = parsePlatformModelsCommand(process.argv.slice(2));
  if ("error" in command) {
    console.error(command.error);
    process.exit(2);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL must name the database owner: the application role may only read the pool.",
    );
    process.exit(2);
  }
  const database = createDatabase(databaseUrl, { max: 1 });
  let code = 0;
  try {
    const result = await runPlatformModelsCommand(database, command);
    if (result.kind === "list") {
      console.info(
        JSON.stringify(
          result.models.map((model) => ({
            ...model,
            // Whether THIS shell has the variable; the server's own environment is what counts.
            keyPresentHere: Boolean(process.env[model.apiKeyEnv]),
          })),
          null,
          2,
        ),
      );
    } else {
      if (result.kind === "missing") code = 1;
      console.info(
        JSON.stringify({
          type: `platform-model-${result.kind}`,
          id: result.id,
        }),
      );
    }
  } catch (error) {
    // The constraint name, not the row: a database error can carry connection details.
    // drizzle wraps the driver's error, so the constraint is on the cause.
    const cause = (error as { cause?: unknown }).cause ?? error;
    const constraint = (cause as { constraint?: unknown } | null)?.constraint;
    console.error(
      typeof constraint === "string"
        ? `Refused by ${constraint}.`
        : "The pool could not be changed; check that DATABASE_URL names the owner.",
    );
    code = 1;
  } finally {
    await database.$client.end({ timeout: 5 });
  }
  process.exit(code);
}
