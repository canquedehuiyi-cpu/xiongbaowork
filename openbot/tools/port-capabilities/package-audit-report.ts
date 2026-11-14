/**
 * `bun run port:audit-report` — 用**包内记录**的档位重写 `tool-ref-audit.md`，并把档位反查回规则表。
 *
 * 为什么不能只靠规则表：`tool-ref-audit.md` 是「到底移植成功了百分之几」的唯一可信答案，而它原先只在
 * `port:capabilities` 落位那一刻生成过一次，之后 109 条技能涨到 109 条、`_porting` 又降了 11 条，报告
 * 却停在 60 行——一份覆盖不到的清单比没有清单更坏，因为读者会以为剩下的都不存在。
 *
 * 口径分两层，两层都要写清：
 *   - **档位（runnable）**以包内记录为准：`skills.yaml` 的 `_porting.runnable`、manifest 的 `runnable`。
 *     这是服务器与徽章实际承诺的东西，报告不许比它更乐观，也不许比它更悲观。
 *   - **证据（命中的引用/原因）**尽量取真实审计器的命中；取不到时（包内账本判出的降级，规则表看不见）
 *     用 `_porting.reason` + `_porting.reason_ref` 里已经写下的那条证据。
 *
 * 一条硬不变量：**包内记录的档位不许比规则表重扫出来的更好**。反了就是包在承诺规则表明说跑不起来的东西，
 * 抛错而不是把报告写成好看的样子——这正是「报告与包同源」要守住的那条线。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  type AuditFinding,
  type AuditHit,
  auditCapabilities,
  shortenSample,
} from "./audit-toolrefs";
import { MISSING_ASSET_RULE_ID } from "./asset-reachability";
import { renderToolRefAudit } from "./emit-package";
import {
  AUDIT_RULE_TABLE,
  type RunnableLevel,
  SEVERITY_ORDER,
} from "./mapping";
import { HOST_SPECIFIC_RULE_ID } from "./verdict-refresh";

/** 包内的自述与它自己的审计结果打架时抛这个。 */
export class PackageReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageReportError";
  }
}

/** 一条能力在包里的记录：决定它该不该跑得起来的那几行。 */
interface RecordedCapability {
  slug: string;
  body: string;
  /** 记录档位；`undefined` 表示包里没记，等同于「没做过移植判定」。 */
  recorded: RunnableLevel | undefined;
  /** 规则 id，`+` 连接，来自 `_porting.reason`。 */
  ruleIds: string[];
  /** 理由 ← 证据，来自 `_porting.reason_ref`。 */
  evidence: string;
}

/** 包内 `_porting` 里本模块要用的字段（其余字段原样不解析，免得把 `refs_bytes` 之类弄丢）。 */
interface PortingBlock {
  runnable?: unknown;
  reason?: unknown;
  reason_ref?: unknown;
}

const LEVELS: readonly RunnableLevel[] = ["full", "degraded", "blocked"];

/** 判一个 YAML 值是不是合法档位；不是就报错，不静默当 full。 */
function asLevel(value: unknown, where: string): RunnableLevel | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value === "string" &&
    (LEVELS as readonly string[]).includes(value)
  ) {
    return value as RunnableLevel;
  }
  throw new PackageReportError(
    `${where} 的 runnable 不是合法档位：${String(value)}`,
  );
}

/** 规则 id 在表格「原因」列的一句话。账本判出来的两个 id 不在规则表里，所以单独给。 */
function reasonTextFor(ruleId: string): string {
  if (ruleId === MISSING_ASSET_RULE_ID) {
    return "正文引用的附件在包内不存在；按文件级账本判定，规则表的布尔 hasBundledReferences 看不见这一类。";
  }
  if (ruleId === HOST_SPECIFIC_RULE_ID) {
    return "该能力只对 WorkBuddy 宿主成立，本部署里没有它依赖的市场与接口。";
  }
  const rule = AUDIT_RULE_TABLE.find((candidate) => candidate.id === ruleId);
  // 未知 id 不编理由：把 id 当理由写出来，读者才知道是记录不全而不是判定成立。
  return rule?.reason ?? `${ruleId}（规则表里没有这个 id）`;
}

/**
 * 把包内账本里那条证据变成一行表格。
 *
 * 引文里的双引号换成单引号：表格单元格已经被一对双引号包着，再套一层会让整行读不出边界。
 */
function synthesizeFinding(capability: RecordedCapability): AuditFinding {
  const { slug, recorded, ruleIds, evidence } = capability;
  if (recorded === undefined || recorded === "full") {
    throw new PackageReportError(`${slug} 没有可合成的降级证据`);
  }
  if (ruleIds.length === 0) {
    throw new PackageReportError(
      `${slug} 记为 ${recorded} 却没有 _porting.reason，报告无从解释档位`,
    );
  }
  if (evidence.trim() === "") {
    throw new PackageReportError(
      `${slug} 记为 ${recorded} 却没有 _porting.reason_ref，报告无从引用证据`,
    );
  }
  const hit: AuditHit = {
    ruleId: ruleIds.join("+"),
    level: recorded,
    sample: shortenSample(evidence.replace(/"/g, "'")),
    reason: ruleIds.map(reasonTextFor).join(" "),
    tier: 4,
  };
  return { slug, level: recorded, hits: [hit], marginal: false };
}

/**
 * 员工侧「包内记录比规则表更严格」时的行。
 *
 * 员工没有 `_porting`：`system_prompt` 有 1000 字符上限合同，降级说明由 persona 技能承载，所以正文里
 * 早就没有那条引用了，规则表只能判 full。证据不在正文里就必须直说，不能借技能侧的理由去凑一行。
 */
const AGENT_RECORD_RULE = "manifest-runnable";

function synthesizeAgentFinding(capability: RecordedCapability): AuditFinding {
  const { slug, recorded } = capability;
  if (recorded === undefined || recorded === "full") {
    throw new PackageReportError(`${slug} 没有可合成的建档档位`);
  }
  const hit: AuditHit = {
    ruleId: AGENT_RECORD_RULE,
    level: recorded,
    sample: shortenSample(
      `capability-manifest.yaml 记为 ${recorded}；员工正文里已无命中的引用（降级说明由 persona 技能承载）`,
    ),
    reason:
      "包内记录的档位比规则表重扫更严格：档位以 manifest 为准，证据不在员工正文里。",
    tier: 4,
  };
  return { slug, level: recorded, hits: [hit], marginal: false };
}

/**
 * 一条能力的最终行：档位用包内记录，证据优先用真实审计器的命中。
 *
 * 重扫比记录更严重时抛错——那说明包在承诺规则表判为跑不起来的东西，报告不能替它圆场。
 */
function mergeFinding(
  capability: RecordedCapability,
  rescanned: AuditFinding | undefined,
  synthesize: (input: RecordedCapability) => AuditFinding,
): AuditFinding {
  const { slug, recorded } = capability;
  if (recorded === undefined) {
    // 没有记录的能力不能凭空出现在报告里：档位是承诺，没承诺就没有可报的东西。
    throw new PackageReportError(
      `${slug} 在 manifest/skills.yaml 里没有 runnable，无法入表`,
    );
  }
  const rescanLevel = rescanned?.level ?? "full";
  if (SEVERITY_ORDER[rescanLevel] > SEVERITY_ORDER[recorded]) {
    throw new PackageReportError(
      `${slug} 记录为 ${recorded}，但规则表重扫判为 ${rescanLevel}：包比审计更乐观，先修包再出报告`,
    );
  }
  if (SEVERITY_ORDER[rescanLevel] === SEVERITY_ORDER[recorded]) {
    // 同档：审计器的引文与 incidental 标记都是真证据，直接用。
    return { ...(rescanned as AuditFinding), level: recorded };
  }
  // 记录更严重：重扫看不见的那一类降级，用包内写下的那条证据。
  return synthesize(capability);
}

/** 读一个可能存在的 YAML 文件；不存在返回 undefined。 */
function readOptionalYaml(path: string): unknown {
  return existsSync(path) ? parseYaml(readFileSync(path, "utf8")) : undefined;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageReportError(`${where} 必须是映射`);
  }
  return value as Record<string, unknown>;
}

function asList(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value))
    throw new PackageReportError(`${where} 必须是序列`);
  return value;
}

/** 包内技能的记录（`skills.yaml`）。 */
function readSkillCapabilities(packageDir: string): RecordedCapability[] {
  const doc = asRecord(
    readOptionalYaml(join(packageDir, "skills.yaml")),
    "skills.yaml",
  );
  const skills = asList(doc.skills, "skills.yaml skills");
  return skills.map((raw) => {
    const skill = asRecord(raw, "skills.yaml skill");
    const slug = String(skill.slug ?? "");
    if (slug === "")
      throw new PackageReportError("skills.yaml 里有不带 slug 的技能");
    const porting = (skill._porting ?? undefined) as PortingBlock | undefined;
    const block =
      porting === undefined ? undefined : asRecord(porting, `${slug}._porting`);
    const reason = typeof block?.reason === "string" ? block.reason : "";
    return {
      slug,
      body: String(skill.instructions ?? ""),
      recorded: asLevel(block?.runnable, `skills.yaml ${slug}`),
      ruleIds: reason
        .split("+")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
      evidence: typeof block?.reason_ref === "string" ? block.reason_ref : "",
    };
  });
}

/**
 * 包内员工的记录：`agents.yaml` 的 5 条种子员工 + `agents/*.yaml` 的逐员工拆分。
 *
 * 两处都要读——只看 `agents.yaml` 会漏掉 23 位从市场落位的专家，而审计表里他们的命中恰恰最多。
 * 档位只在 manifest 里，所以这里只负责把正文找出来，档位由 {@link readManifestLevels} 补。
 */
function readAgentBodies(packageDir: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const doc = readOptionalYaml(join(packageDir, "agents.yaml"));
  if (doc !== undefined) {
    const agents = asList(
      asRecord(doc, "agents.yaml").agents,
      "agents.yaml agents",
    );
    for (const raw of agents) {
      const agent = asRecord(raw, "agents.yaml agent");
      bodies.set(String(agent.id ?? ""), String(agent.system_prompt ?? ""));
    }
  }
  const agentsDir = join(packageDir, "agents");
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir).sort()) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      const one = asRecord(
        readOptionalYaml(join(agentsDir, name)),
        `agents/${name}`,
      );
      const id = String(one.id ?? "");
      if (id === "") throw new PackageReportError(`agents/${name} 没有 id`);
      bodies.set(id, String(one.system_prompt ?? ""));
    }
  }
  return bodies;
}

/** manifest 里的档位，按 kind 分组。manifest 是员工档位的唯一记录处。 */
function readManifestLevels(
  packageDir: string,
  kind: string,
): Map<string, RunnableLevel> {
  const rows = asList(
    readOptionalYaml(join(packageDir, "capability-manifest.yaml")),
    "capability-manifest.yaml",
  );
  const levels = new Map<string, RunnableLevel>();
  for (const raw of rows) {
    const row = asRecord(raw, "capability-manifest row");
    if (row.kind !== kind) continue;
    const slug = String(row.slug ?? "");
    const level = asLevel(row.runnable, `capability-manifest ${slug}`);
    if (level === undefined) {
      throw new PackageReportError(`capability-manifest ${slug} 缺 runnable`);
    }
    levels.set(slug, level);
  }
  return levels;
}

/** 包内声明的 connector id：`unknown-mcp-server` 规则要拿它判 `mcp__<server>__<tool>`。 */
function readConnectorIds(packageDir: string): Set<string> {
  const doc = readOptionalYaml(join(packageDir, "connectors.yaml"));
  if (doc === undefined) return new Set();
  const connectors = asList(
    asRecord(doc, "connectors.yaml").connectors,
    "connectors.yaml connectors",
  );
  return new Set(
    connectors.map((raw) => String(asRecord(raw, "connector").id ?? "")),
  );
}

/** 一份包的两段审计表，按 slug 排序（表是给人按名字找的）。 */
export interface PackageReport {
  skills: AuditFinding[];
  agents: AuditFinding[];
}

/**
 * 读一份包，产出与 `port:capabilities` 同形同措辞的两段审计表。
 *
 * 只读盘：不改包、不写报告。写盘在 CLI 的 `main` 里，方便测试对同一份输入重复调用。
 */
export function buildPackageReport(packageDir: string): PackageReport {
  const connectorIds = readConnectorIds(packageDir);
  const skills = readSkillCapabilities(packageDir);
  const scannedSkills = new Map(
    auditCapabilities(
      skills.map((skill) => ({
        slug: skill.slug,
        instructions: skill.body,
        // 包内 `references/` 目录就是这条规则能看到的「随包附上」——文件级缺口的判断在账本里，不在这。
        hasBundledReferences: existsSync(
          join(packageDir, "skills", skill.slug, "references"),
        ),
      })),
      connectorIds,
    ).map((finding) => [finding.slug, finding]),
  );

  const agentLevels = readManifestLevels(packageDir, "agent");
  const agentBodies = readAgentBodies(packageDir);
  const agents: RecordedCapability[] = [...agentLevels.entries()].map(
    ([slug, recorded]) => {
      const body = agentBodies.get(slug);
      if (body === undefined) {
        throw new PackageReportError(
          `manifest 有 agent ${slug}，但 agents.yaml / agents/*.yaml 里没有它的正文`,
        );
      }
      return { slug, body, recorded, ruleIds: [], evidence: "" };
    },
  );
  const scannedAgents = new Map(
    auditCapabilities(
      agents.map((agent) => ({
        slug: agent.slug,
        instructions: agent.body,
        hasBundledReferences: existsSync(
          join(packageDir, "agents", agent.slug, "references"),
        ),
      })),
      connectorIds,
    ).map((finding) => [finding.slug, finding]),
  );

  return {
    skills: skills
      .map((skill) =>
        mergeFinding(skill, scannedSkills.get(skill.slug), synthesizeFinding),
      )
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    agents: agents
      .map((agent) =>
        mergeFinding(
          agent,
          scannedAgents.get(agent.slug),
          synthesizeAgentFinding,
        ),
      )
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

/**
 * 报告落位后多出来的一段：说明「档位从哪来」。
 *
 * 不加这一段，读者会以为整张表都是规则表算的；实际上有 10 条是包内账本判的，规则表根本看不见它们。
 * 少这一句，这份报告就退回成一份「看起来很严格」的清单。
 */
const SCOPE_NOTE = [
  "## 口径（档位从哪来，读者必须知道）",
  "",
  "- 生成命令：`bun run port:audit-report -- --package <包目录>`；`--check` 只比对不写盘。表头措辞与",
  "  `port:capabilities` 落位时写的一致，区别只在本文件是**按包内记录重算**的，不是那一刻的抄本。",
  "- **档位**取自包内记录：`skills.yaml` 的 `_porting.runnable` 与 `capability-manifest.yaml` 的",
  "  `runnable`。这是服务器与徽章实际承诺的东西，本报告与它逐条一致（`package-audit-report.test.ts` 钉住）。",
  "- **证据**优先取规则表重扫的命中；重扫看不见、由包内账本判出来的降级（规则 id 为",
  "  `missing-asset-references` / `host-specific-skill`），引用 `_porting.reason_ref` 里已经写下的那条证据。",
  "- 规则表用布尔 `hasBundledReferences` 判断附件在不在，所以「目录在、文件缺」这一类它看不见；账本按文件判定。",
  "  两边结论不一致时**以更严格的一边为准**，包不许比审计更乐观——反了直接报错，不出一份好看的报告。",
  "",
];

/** 渲染整份 `tool-ref-audit.md`：与 `port:capabilities` 同形，末尾多一段口径说明。 */
export function renderPackageAuditReport(packageDir: string): string {
  const report = buildPackageReport(packageDir);
  return `${renderToolRefAudit(report.skills, report.agents)}${SCOPE_NOTE.join("\n")}`;
}

/** 报告在包里的固定文件名。 */
export const REPORT_FILE = "tool-ref-audit.md";

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;
const EXIT_USAGE = 2;

const USAGE = `用法：
  bun run port:audit-report -- --package <品牌包目录> [--check]

说明：
  按包内记录的档位重写 <包>/tool-ref-audit.md。--check 只比对不写盘：报告与包不一致时退出码 1。`;

/** CLI entry point; returns a process exit code so tests can drive `main` directly. */
export function main(argv: readonly string[]): number {
  let packageDir = "";
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      check = true;
      continue;
    }
    if (flag !== "--package") {
      console.error(`[port:audit-report] 无法识别的参数：${flag}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      console.error(`[port:audit-report] --package 缺少取值\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    packageDir = next;
    index += 1;
  }
  if (packageDir === "") {
    console.error(`[port:audit-report] 缺少 --package\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  const path = join(packageDir, REPORT_FILE);
  try {
    const rendered = renderPackageAuditReport(packageDir);
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current === rendered) {
      console.log(`[port:audit-report] ${path} 与包内记录一致`);
      return EXIT_OK;
    }
    if (check) {
      console.error(
        `[port:audit-report] ${path} 与包内记录不一致（--check 不写盘）`,
      );
      return EXIT_MISMATCH;
    }
    writeFileSync(path, rendered, "utf8");
    console.log(`[port:audit-report] 已重写 ${path}`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof PackageReportError) {
      console.error(`[port:audit-report] 失败：${error.message}`);
      return EXIT_MISMATCH;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
