/**
 * Static tables that describe how a WorkBuddy capability lands in openbot.
 *
 * Everything here is data, not behaviour, so the diff of a porting run can be explained by reading
 * one file. Three tables live here because each one is the single source of truth for a decision the
 * rest of the pipeline must not re-derive:
 *
 *   1. `TOOL_NAME_MAP`      — what a WorkBuddy tool ref becomes on an openbot employee (§5.1 of the plan).
 *   2. `AUDIT_RULE_TABLE`   — the rules that decide whether a ported instruction body can still run (§5.3).
 *   3. `CONNECTOR_PRESETS`  — the human-facing metadata openbot needs but `mcp.json` does not carry.
 *
 * P0 is a porting pipeline only: nothing here rewrites instruction text yet. The map exists so P3 can
 * rewrite against a table that has already been reviewed, and so the auditor can say *why* a hit
 * degrades a skill instead of only that it matched.
 */

/**
 * How usable a ported capability is on an openbot employee.
 *
 * Ordered from best to worst; `SEVERITY_ORDER` turns the ordering into something `Math.max` can use,
 * which is how the auditor reduces many hits to one verdict.
 */
import { createHash } from "node:crypto";

export type RunnableLevel = "full" | "degraded" | "blocked";

/** Numeric weight for each level. Higher wins when a body hits several rules. */
export const SEVERITY_ORDER: Readonly<Record<RunnableLevel, number>> = {
  full: 0,
  degraded: 1,
  blocked: 2,
};

/** How closely an openbot tool reproduces the WorkBuddy one. */
export type Equivalence = "exact" | "partial" | "none";

/** One row of the WorkBuddy → openbot tool name table. */
export interface ToolMapping {
  /** The spelling that appears in WorkBuddy instruction bodies. */
  readonly workbuddy: string;
  /** The openbot tool this becomes, or `null` when openbot has no counterpart. */
  readonly openbot: string | null;
  /** How close the counterpart is. `none` means the instruction cannot be honoured. */
  readonly equivalence: Equivalence;
  /** One sentence a reviewer can paste into the audit report. */
  readonly note: string;
}

/**
 * §5.1 of the plan, verbatim, with the tool names openbot's own employee toolkit exposes.
 *
 * Nothing in P0 consumes `openbot` yet — `skills.yaml` emits `tools: []` because a WorkBuddy
 * `allowed-tools` entry such as `Bash(git:*)` cannot be converted mechanically into openbot's
 * `<serverId>/<toolName>` reference. The column is here so P3 rewrites from a reviewed table rather
 * than from a regex invented at rewrite time.
 */
export const TOOL_NAME_MAP: readonly ToolMapping[] = [
  {
    workbuddy: "Read",
    openbot: "computer_read_file",
    equivalence: "partial",
    note: "读取路径可用，但没有工作区根与行号语义。",
  },
  {
    workbuddy: "Write",
    openbot: "computer_write_file",
    equivalence: "partial",
    note: "整文件覆盖可用，没有 diff/patch 语义。",
  },
  {
    workbuddy: "Edit",
    openbot: "computer_write_file",
    equivalence: "partial",
    note: "需要先读后写整文件；没有 old/new 片段替换。",
  },
  {
    workbuddy: "MultiEdit",
    openbot: "computer_write_file",
    equivalence: "partial",
    note: "多个编辑要合并成一次整文件写入。",
  },
  {
    workbuddy: "Glob",
    openbot: "computer_list_files",
    equivalence: "partial",
    note: "可以列目录，通配语义靠模型自己筛。",
  },
  {
    workbuddy: "Grep",
    openbot: null,
    equivalence: "none",
    note: "openbot 无 grep 工具，且不做 shim：落到哪台机器上说不清，正路是「在我电脑上跑」。",
  },
  {
    workbuddy: "WebFetch",
    openbot: "computer_navigate",
    equivalence: "partial",
    note: "需要先 navigate 再 read，返回的是可见文本而非原文。",
  },
  {
    workbuddy: "Bash",
    openbot: null,
    equivalence: "none",
    note: "openbot 员工没有本地 shell、Python 与 Node，不可等价。",
  },
  {
    workbuddy: "Task",
    openbot: null,
    equivalence: "none",
    note: "没有子代理；对应物是 handoff（@同事），异步、需授权、有深度与扇出上限。",
  },
  {
    workbuddy: "Skill",
    openbot: "skill_invoke",
    equivalence: "exact",
    note: "技能调用等价，openbot 侧就是 /<slug>。",
  },
  {
    workbuddy: "mcp__<server>__<tool>",
    openbot: "<serverId>/<toolName>",
    equivalence: "exact",
    note: "写法不同，语义一致；serverId 必须出现在 connectors.yaml 里。",
  },
];

/**
 * Index `TOOL_NAME_MAP` by its WorkBuddy spelling.
 *
 * P3 内容改写层使用，P0 不消费：P0 只做静态审计（把引用判成 full/degraded/blocked），不改写正文，
 * 所以这里在 P0 没有调用点。它是留给 P3 改写 pass 的 API，不是死代码，别当垃圾清掉。
 */
export function toolMapping(workbuddy: string): ToolMapping | undefined {
  return TOOL_NAME_MAP.find((row) => row.workbuddy === workbuddy);
}

/**
 * What a rule inspects.
 *
 * - `pattern`: a plain regular expression over the instruction body.
 * - `mcp-server`: `mcp__<server>__<tool>` references, judged against the connector set rather than
 *   matched blindly, because the same reference is fine once the connector ships.
 * - `references-without-assets`: `references/…` mentions, judged against whether the skill actually
 *   carries the directory it points at.
 */
export type AuditRuleKind = "pattern" | "mcp-server" | "references-without-assets";

/** One rule of the §5.3 table. */
export interface AuditRule {
  /** Stable id, used in the audit table and in tests. */
  readonly id: string;
  /** Verdict this rule assigns when it fires. */
  readonly level: RunnableLevel;
  /** What the rule inspects. */
  readonly kind: AuditRuleKind;
  /** The expression for `pattern` and `references-without-assets` rules. */
  readonly pattern?: RegExp;
  /** Why this hit matters, in the words a reviewer needs. */
  readonly reason: string;
}

/**
 * The command words that make a line worth inspecting. A line containing one of these is *not* evidence by
 * itself — `Do NOT run bash commands` and `用 node junction` both contain one and both mean the opposite of
 * "the model must shell out". See {@link SHELL_COMMAND_PROSE} for what turns a mention into a hit.
 *
 * Only names that are a command and nothing else belong here. `make`, `go` and `run` are deliberately
 * absent even though they start real command lines: `make sure to check /path` and `go to C:/Users/...`
 * are ordinary English, so the word alone would fire and the rule would collect prose. `git`, `npx`,
 * `docker`, `kubectl` and `ssh` are unambiguous, and without `git` a recipe whose real dependency is
 * `git bundle create …` could only be caught by a nearby sentence describing it.
 */
const SHELL_COMMAND_WORDS =
  "bash|sh|zsh|python3?|node|npm|pnpm|yarn|deno|bun|pwsh|powershell|cmd|git|npx|docker|kubectl|ssh";

/**
 * The shell features that turn a command *mention* into a command *dependency*.
 *
 * Four kinds, because these are what a runnable instruction actually looks like: a heredoc, a flag, an
 * argument shaped like a path or a file, and a shell operator. `bash commands` has none of them, which is
 * the whole point — the previous single-regex version accepted any following word (`\w`) as an argument and
 * so flagged a sentence that *forbids* running bash.
 *
 * A bare `|` is deliberately absent. Markdown tables put a pipe after almost every cell, so allowing it
 * would turn ``| `python` | 3.8+ |`` into a shell dependency; `||`, `&&`, `$(` and redirection still cover
 * the real operators.
 */
const SHELL_COMMAND_PROSE_FEATURES = [
  "<<-?[ \\t]*['\"`]?\\w+", // heredoc, with or without the leading dash: `<<EOF`, `- <<'EOF'`
  "(?<=\\s)-{1,2}[A-Za-z]", // a flag: `-c`, `--selftest`
  // A path-shaped argument, anchored: absolute, home-relative or drive-rooted. Deliberately *not* any
  // `a/b`: Chinese prose writes `bash 的 mkdir/cp 认 /c/...` to mean "mkdir or cp", and an unanchored
  // slash turned that alternative into a shell dependency.
  "[\\s`'\"](?:/[^\\s/]|~/|[A-Za-z]:[\\\\/]|\\.{1,2}/)",
  "\\S*\\.[A-Za-z]{1,5}(?=\\s|$)", // an argument shaped like a file: `build.mjs`, not a version like `3.8`
  "\\|\\||&&|\\$\\(", // a shell operator
  // Redirection stays on its own line. `\s` includes `\n`, so `>\s*\S` read the `>` closing a prose
  // placeholder as a redirect onto the *next* line: the agent body line `Branch: <git branch>` was
  // blocked by the `R` of the following line. A real redirect never spans a line break.
  ">[ \\t]*\\S",
  "<[ \\t]*\\(", // process substitution
].join("|");

/** Rule B's pattern, exported so the tests can pin every feature independently. */
export const SHELL_COMMAND_PROSE = new RegExp(
  `(?<![\\w-])(?:${SHELL_COMMAND_WORDS})\\b[ \\t][^\\n]{0,80}?(?:${SHELL_COMMAND_PROSE_FEATURES})`,
  "m",
);

/**
 * The audit table, in the order §5.3 lists it.
 *
 * The shell rule is split in two on purpose. One regex cannot both recognise a *tool call* and recognise a
 * *command mentioned in prose*, and trying cost us a false positive on the sentence "Do NOT run bash
 * commands to create directories": `\w` accepted `c` as an argument, so a prohibition read as a dependency.
 * Rule A answers "is the model told to call a shell tool"; rule B answers "does the prose name a command
 * with something to run it on".
 *
 * Rule A carries one **accepted** false positive: prose like `Bash (shell)` — half-width parenthesis with a
 * space — trips it. Do not "fix" that. Any loosening of the half-width paren form also stops matching
 * `Bash(npm install)`, which is the real call this rule exists for, and Chinese text uses the full-width
 * `（`, which does not match anyway.
 */
export const AUDIT_RULE_TABLE: readonly AuditRule[] = [
  {
    id: "shell-tool-call",
    level: "blocked",
    kind: "pattern",
    pattern: /\b(?:Bash|Shell|Terminal)\s*\(/,
    reason: "正文调用 Bash/Shell/Terminal(...)；openbot 员工没有本地 shell。",
  },
  {
    id: "shell-command-prose",
    level: "blocked",
    kind: "pattern",
    pattern: SHELL_COMMAND_PROSE,
    reason: "正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。",
  },
  {
    id: "executable-scripts",
    level: "blocked",
    kind: "pattern",
    pattern: /(?<![\w/.-])scripts\//,
    reason: "正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。",
  },
  {
    id: "unknown-mcp-server",
    level: "blocked",
    kind: "mcp-server",
    reason: "正文引用 mcp__<server>__<tool>，而该 server 不在 connectors.yaml 里。",
  },
  {
    id: "file-tool-call",
    level: "degraded",
    kind: "pattern",
    pattern: /\b(?:Read|Write|Edit|MultiEdit|Glob|Grep|WebFetch)\s*\(/,
    reason: "正文调用文件类工具；openbot 只有 computer_* 的近似物，无 grep。",
  },
  {
    id: "subagent-task",
    level: "degraded",
    kind: "pattern",
    pattern: /\bTask\s*\(/,
    reason: "正文调用 Task(...) 起子代理；openbot 侧只能改成 @同事 交接。",
  },
  {
    id: "references-without-assets",
    level: "degraded",
    kind: "references-without-assets",
    pattern: /(?<![\w/.-])references\//,
    reason: "正文引用 references/ 下的附件，而该技能没有随包附上 references/。",
  },
];

/** Look one rule up by id. Throws on an unknown id, so a typo in a test fails loudly. */
export function auditRule(id: string): AuditRule {
  const rule = AUDIT_RULE_TABLE.find((candidate) => candidate.id === id);
  if (!rule) {
    throw new Error(`unknown audit rule: ${id}`);
  }
  return rule;
}

/**
 * The slug shape the tenant-package loader enforces: lowercase letters, digits and hyphens, 2 to 40
 * characters, starting and ending with a letter or digit.
 *
 * Copied from `server/src/tenant-package.ts` (`parseTenantSkills`), which throws on anything else. Two
 * consequences the port has to live with: **no underscores**, so a WorkBuddy directory name such as
 * `dev-expert__skillhub` cannot be used verbatim; and **40 characters**, which a
 * `<package>--<skill>` name can exceed. A slug this pipeline emits but the loader rejects is a package
 * that fails to boot, so the shape is checked here and again at emit time.
 */
export const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** Longest slug the loader accepts. */
export const TENANT_SLUG_MAX = 40;

/**
 * Fingerprint of the audit ruleset: what a `runnable` verdict was produced by.
 *
 * A verdict carries no version of its own, and the rules changed twice in a day. Without this number a
 * report from yesterday cannot be told apart from one produced by a different rule set, which makes every
 * "34 of 60 can run" claim unattributable. The manifest carries the hash in a header comment; the audit
 * report prints the same value from the same function, so there is one source of truth.
 *
 * What goes in, and why:
 *
 *   - every rule, sorted by id, as `id \t level \t kind \t pattern.source \t pattern.flags` — sorted so
 *     that reordering the table (a semantically empty edit) does not change the number;
 *   - `severity_order`, joined **in rank order** (`0:full;1:degraded;2:blocked`). This is the one line that
 *     is deliberately order-sensitive: the final verdict is decided by "worst wins", so flipping the ranks
 *     would rewrite every `runnable` in the manifest while leaving a key-sorted fingerprint unchanged —
 *     the exact failure this hash exists to catch;
 *   - the rule count, so a silently dropped rule cannot pass unnoticed.
 *
 * Excluded on purpose: absolute paths, timestamps, versions and machine names — the hash must be equal for
 * the same source on every machine, or it becomes a second thing to diff.
 */
export function auditRulesSha256(
  rules: readonly AuditRule[] = AUDIT_RULE_TABLE,
  severity: Readonly<Record<RunnableLevel, number>> = SEVERITY_ORDER,
): string {
  const lines = [...rules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((rule) =>
      [
        rule.id,
        rule.level,
        rule.kind,
        rule.pattern === undefined ? "" : rule.pattern.source,
        rule.pattern === undefined ? "" : rule.pattern.flags,
      ].join("\t"),
    );
  const severityOrder = Object.entries(severity)
    // Rank ascending, i.e. the order the levels actually appear in. Sorting by key name here would make
    // `full>degraded>blocked` and its reverse hash identically.
    .sort(([, left], [, right]) => left - right)
    .map(([level, rank]) => `${rank}:${level}`)
    .join(";");
  lines.push(`severity_order\t${severityOrder}`);
  lines.push(`rules_count\t${rules.length}`);
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** Whether a string can be used as `skills.slug` / an agent id without the loader refusing it. */
export function isTenantSlug(value: string): boolean {
  return TENANT_SLUG_PATTERN.test(value);
}

/** Metadata a connector needs in openbot but that `mcp.json` does not carry. */
export interface ConnectorPreset {
  /** Who publishes the remote server. */
  readonly vendor: string;
  /**
   * How openbot authenticates against it.
   *
   * One concept, one name: `deployment-bearer` is the deployment holding one token and spending it on
   * everyone's behalf, which is exactly what WorkBuddy's `auth_mode: token` describes. This used to be
   * called `tenant-credential` here, which would have been a second name for `CatalogueEntry.auth`'s
   * existing value — a translation to maintain for no gain.
   */
  readonly auth: "user-oauth" | "deployment-bearer";
  /** Environment variable openbot reads the credential id from. */
  readonly credentialEnv: string;
}

/**
 * The three connectors authorised on this machine, with the metadata openbot needs.
 *
 * P0 ports only what the user has actually authorised — the marketplace ships 298 connector
 * definitions, and shipping all of them would create 295 entries nobody can authenticate against.
 *
 * `title` is not here: it comes from the marketplace index (`connectors.json`'s Chinese `name`), which
 * is one more field this table does not have to keep in sync with the source.
 */
export const CONNECTOR_PRESETS: Readonly<Record<string, ConnectorPreset>> = {
  github: {
    vendor: "GitHub",
    auth: "user-oauth",
    credentialEnv: "GITHUB_MCP_CREDENTIAL_ID",
  },
  tapd: {
    vendor: "腾讯",
    auth: "deployment-bearer",
    credentialEnv: "TAPD_MCP_CREDENTIAL_ID",
  },
  "tencent-docs": {
    vendor: "腾讯",
    auth: "user-oauth",
    credentialEnv: "TENCENT_DOCS_MCP_CREDENTIAL_ID",
  },
};

/**
 * WorkBuddy's `auth_mode` → openbot's carrier, as measured on the 298-entry marketplace index.
 *
 * `null` means openbot has no equivalent, and the value has to be recorded as a drop rather than
 * mapped: WorkBuddy's `server-side` is a platform-held credential (a connector gateway holds it and
 * nobody on our side does), and openbot's three carriers are `deployment-bearer`, `user-oauth` and
 * `builtin` — there is no "somebody else holds it but it still works" mode.
 *
 * Measured distribution over the 298 marketplace entries: `none` 166, `token` 69, `oauth` 5,
 * `server-side` 12, `oneid-token` 1, `cli` 44, missing 1. Together with 15 stdio `command` connectors,
 * that is ~72 of 298 (24%) structurally unportable — the number L1 planning has to carry.
 */
export const AUTH_MODE_MAP: Readonly<Record<string, "none" | "deployment-bearer" | "user-oauth" | null>> = {
  none: "none",
  token: "deployment-bearer",
  oauth: "user-oauth",
  "server-side": null,
  "oneid-token": null,
  cli: null,
};

/** Map a WorkBuddy `auth_mode` onto an openbot carrier; `null` when there is no equivalent. */
export function openbotAuthFor(authMode: string | undefined): "none" | "deployment-bearer" | "user-oauth" | null {
  if (authMode === undefined) {
    return null;
  }
  return AUTH_MODE_MAP[authMode] ?? null;
}

/**
 * Credential environment variable for a connector, derived rather than hand-written.
 *
 * Only a fallback: the three P0 connectors keep the names already promised to deployment configs.
 */
export function deriveCredentialEnv(connectorId: string): string {
  return `${connectorId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MCP_CREDENTIAL_ID`;
}

/**
 * Connectors P0 is allowed to port.
 *
 * A connector without a user grant is not "ported but off" in openbot: it is an MCP server the
 * employee cannot reach, and every `mcp__<id>__<tool>` reference in a skill body would point at
 * nothing. Restricting the set keeps the auditor honest.
 */
export const CONNECTOR_ALLOWLIST: readonly string[] = ["github", "tapd", "tencent-docs"];

/**
 * Team display names for packages whose `plugin.json` carries no `displayName`.
 *
 * `software-company` is the only such package on this machine: it has `members[]` but no
 * `displayName`, and a Chinese team name cannot be derived from a kebab id. Keeping the override in a
 * table (rather than in the converter) means the next package that ships without metadata is fixed by
 * adding a line here, and a missing override is visible instead of silently producing `software-company`
 * as the channel's name.
 */
export const TEAM_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  "software-company": "软件公司",
};

/** Licence id used whenever the source declares none. Never guess a licence. */
export const UNSPECIFIED_LICENSE = "unspecified";

/**
 * Licence identifiers this pipeline treats as allowing redistribution.
 *
 * Deliberately short: the point of the manifest is that everything else says `redistributable: false`
 * so a human reviews it, rather than a permissive default quietly shipping marketplace content.
 */
export const PERMISSIVE_LICENSES: readonly string[] = ["mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "isc"];

/** Attribution used when the source declares no author. */
export const DEFAULT_ATTRIBUTION = "© WorkBuddy 能力市场";
