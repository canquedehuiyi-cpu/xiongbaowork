/** The prefix of the product's own settings: `XIONGBAO_PUBLIC_URL`, `XIONGBAO_RLS_ENFORCE`, … */
export const NEW_PREFIX = "XIONGBAO_";

/**
 * The prefix the same settings had before v0.2.16. Read only to refuse it: v0.2.16 read both and its
 * upgrade sheet renamed every line, and this release reads the new names alone, so a setting still under
 * the old one would be silently ignored rather than refused.
 */
export const OLD_PREFIX = "OPENBOT_";

/**
 * The product's own settings, by what follows the prefix: every `XIONGBAO_<X>` this release reads from its
 * environment (the server, the worker, the runner, the computer, the supervisor, the app's servers, the
 * scripts, the Compose files, the chart and the device app). Only these are refused under the old prefix:
 * a variable of some other tool that happens to share it (an external release tool's
 * `<old prefix>UPSTREAM_*`, for one) is nobody's setting here. `server/tests/env-name.test.ts` holds this list
 * to the source, and `docker/s6/scripts/env-defaults.sh` repeats it.
 */
export const PRODUCT_SETTINGS: readonly string[] = [
  "ACCEPT_WITH_READS",
  "ACCESSIBILITY_DISABLED",
  "ACP_ADAPTERS_DIR",
  "ACP_STATE_DIR",
  "AGENT_DESKTOP_BINARY",
  "AGENT_MODEL_COMPUTER_URL",
  "AGENT_MODEL_PROXY",
  "AGENT_MODEL_PUBLIC_URL",
  "AGENT_MODEL_RATE_PER_MINUTE",
  "AGENT_MODEL_TOKEN",
  "APP_URL",
  "ARCH",
  "AUTO_COMPACTION",
  "BROKER_PROVIDER",
  "CARD_AUTOCLAIM",
  "CHAT_SERVER_COMPUTER_TOOLS",
  "COMMAND_INLINE_BYTES",
  "CONTENT_BIND",
  "CONTENT_DOMAIN",
  "CONTENT_HOST_PORT",
  "CONTENT_PORT",
  "CRAWL_CONTAINER_URL",
  "CRAWL_TOKEN",
  "CRAWL_URL",
  "CREDENTIAL_LOCK",
  "DATABASE_WAIT_HINT",
  "DATABASE_WAIT_SECONDS",
  "DELIVER_ENDS_TURN",
  "DELIVER_NUDGE",
  "DEPLOYMENT",
  "DESKTOP_ENGINE",
  "DESKTOP_HELPER",
  "DESKTOP_HOST_TOKEN",
  "DEV_NO_AUTH",
  "DISTRIBUTION",
  "EDITION",
  "EMBEDDING_API_KEY",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_MODEL",
  "ENGINE",
  "FASTPATH_CHECK_GATE",
  "GENERATIVE_UI",
  "GROUP_TURN_WORKERS",
  "GROUP_UPGRADE",
  "HEADLESS_ANSWER_FORMAT",
  "HEARTBEAT",
  "HEAVY_TASK_ROUTING",
  "HOST_GATEWAY",
  "IMAGE",
  "IMAGE_API_KEY",
  "IMAGE_BASE_URL",
  "IMAGE_MODEL",
  "INBOUND_EMAIL_DOMAIN",
  "INBOUND_EMAIL_SNS_TOPIC_ARNS",
  "IN_CONTAINER",
  "LEARNING_MODEL_TOKEN",
  "LOCAL_COMPUTER_DIR",
  "LOCAL_LEARNING",
  "MAX_PARALLEL_CARDS",
  "MEMORY_CORRECTIONS",
  "MEMORY_EXTRACT",
  "MEMORY_EXTRACT_PER_DAY",
  "MEMORY_INJECT_CHARS",
  "MEMORY_SOURCE_DEFAULTS",
  "MEMORY_STICKY",
  "MERGE_COMMANDS",
  "MODEL_CAPABILITIES_URL",
  "MODEL_NET_RETRY",
  "MODEL_OAUTH_FILE",
  "NPM_REGISTRY",
  "NUDGE_WHOLE_TURN",
  "ONE_COMPUTER_EACH",
  "OPENAI_API",
  "ORGANIZATION_AUTH_URL",
  "OS_VERSION",
  "OTEL_EXPORT",
  "PARALLEL_TOOLS",
  "PERSONAL_MEMORY",
  "PHYSICAL_GATE",
  "PLAN_WITH_ACTION",
  "PLATFORM",
  "PORT",
  "PROACTIVE_DEFAULTS",
  "PROMPT_SLIM",
  "PUBLIC_URL",
  "QUIET_BUILD_OUTPUT",
  "QUIET_HOURS",
  "READ_INLINE_BYTES",
  "RETRO_CARD_MIN_STEPS",
  "RETRO_MIN_STEPS",
  "RETRO_PER_DAY",
  "RETRO_TOTAL_TIMEOUT_MS",
  "RLS_ENFORCE",
  "RUNNER_BINARY",
  "RUNNER_DATA_DIR",
  "SEARCH_CONTAINER_URL",
  "SEARCH_PROVIDER",
  "SEARCH_URL",
  "SEARXNG_SECRET",
  "SELF_HOST_BANNER",
  "SERVER_USER",
  "SINGLE_USER",
  "SKILLS_PER_EMPLOYEE",
  "SKILL_CHOOSE_CACHE",
  "TAG",
  "TENANT_FRAME_GUARD",
  "TESTS_PASSED_HINT",
  "THIS_MACHINE_CONTAINER_HOST",
  "THIS_MACHINE_HOST",
  "TOOL_URL",
  "TURN_FOLD",
  "TURN_FOLD_BRIEF",
  "TURN_FOLD_BUDGET_TOKENS",
  "TURN_FOLD_CALLS",
  "TURN_NOTICE_WINDOW_SECONDS",
  "UPDATE_OPERATION",
  "VERIFY_NUDGE",
  "VERSION",
  "VIDEO_API_KEY",
  "VIDEO_BASE_URL",
  "VIDEO_MODEL",
  "VIDEO_PROVIDER",
  "WORKING_EVENT_TYPES",
];

/**
 * Settings named per entry rather than one by one: a platform model key (`XIONGBAO_POOL_<X>`, named in the
 * model pool) and a build identity (`XIONGBAO_BUILD_<X>`, written by the image's build).
 */
export const PRODUCT_SETTING_FAMILIES: readonly string[] = ["BUILD_", "POOL_"];

/** Whether `suffix` (what follows the prefix) names one of the product's settings. */
export function isProductSetting(suffix: string): boolean {
  return (
    PRODUCT_SETTINGS.includes(suffix) ||
    PRODUCT_SETTING_FAMILIES.some(
      (family) => suffix.startsWith(family) && suffix.length > family.length,
    )
  );
}

/**
 * The product's settings under the old prefix with a value whose new name is unset or empty, sorted: the
 * ones a deployment that skipped v0.2.16 still relies on. A setting under both names is not one of them
 * (the new one is in effect, as it was in v0.2.16), and neither is another tool's variable that only shares
 * the prefix ({@link isProductSetting}).
 */
export function settingsUnderOldNamesOnly(
  environment: Record<string, string | undefined>,
): string[] {
  return Object.keys(environment)
    .filter(
      (name) =>
        name.startsWith(OLD_PREFIX) &&
        isProductSetting(name.slice(OLD_PREFIX.length)) &&
        (environment[name] ?? "") !== "" &&
        (environment[NEW_PREFIX + name.slice(OLD_PREFIX.length)] ?? "") === "",
    )
    .sort();
}

/** What a process that refuses those settings says: by name only, never a value. */
export function oldSettingsRefusal(names: readonly string[]): string {
  const renamed = names.map(
    (name) => NEW_PREFIX + name.slice(OLD_PREFIX.length),
  );
  return `这些设置还是 v0.2.16 之前的旧名，这个版本不再读取，不启动：${names.join(", ")}。这个版本只能从 v0.2.16 升级上来：请先升级到 v0.2.16（按它的升级单把旧名改成新名），或者把每一行改成对应的新名（${renamed.join(", ")}）后再启动。`;
}

/** Throws {@link oldSettingsRefusal} when {@link settingsUnderOldNamesOnly} finds any. */
export function refuseOldSettingNames(
  environment: Record<string, string | undefined>,
): void {
  const names = settingsUnderOldNamesOnly(environment);
  if (names.length > 0) throw new Error(oldSettingsRefusal(names));
}

/**
 * The name a message shows for a setting: `envName("PUBLIC_URL")` is `XIONGBAO_PUBLIC_URL`.
 *
 * Every sentence that tells an operator which variable to set goes through here, so the name it gives
 * is the one this release reads.
 */
export function envName(suffix: string): string {
  return `${NEW_PREFIX}${suffix}`;
}
