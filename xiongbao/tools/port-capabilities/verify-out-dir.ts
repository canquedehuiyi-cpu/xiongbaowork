/**
 * `--verify` / `--verify-only`：回读写出的目录，按与生成时同一套规则再校验一遍。
 *
 * 从 `index.ts` 拆出来（技术债 #25）。这里只读盘、只返回问题清单——不打印、不改盘、不定退出码，
 * 那三件事留在 `main` 里。因此 `verifyOutDir` 可以在单测里直接断言，而不用捕获 stdout。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { EMITTED_REPORT_FILES, EMITTED_YAML_FILES } from "./emit-package";
import { validateManifest } from "./manifest";
import { auditRulesSha256 } from "./mapping";

/** One problem found by `--verify`. */
export interface VerifyProblem {
  file: string;
  detail: string;
}

/** Cast a parsed YAML value to a record, or an empty one. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Cast a parsed YAML value to a list of records. */
function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((entry) => asRecord(entry)) : [];
}

/** Read `agents.yaml` and return the ids and skill grants. */
function readAgents(
  filePath: string,
  problems: VerifyProblem[],
): { ids: string[]; grantCount: number; skills: string[] } {
  const doc = asRecord(parseYaml(readFileSync(filePath, "utf8")));
  const rows = asRecordList(doc.agents);
  // 空列表不算问题：只带技能或只带连接器的合法包，agents 就是空的。三类全空的判定在 verifyOutDir。
  const ids: string[] = [];
  const skills: string[] = [];
  let grantCount = 0;
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    if (id === "") {
      problems.push({ file: "agents.yaml", detail: "存在没有 id 的 agent" });
      continue;
    }
    ids.push(id);
    if (
      typeof row.system_prompt !== "string" ||
      row.system_prompt.trim() === ""
    ) {
      problems.push({
        file: "agents.yaml",
        detail: `${id} 的 system_prompt 为空`,
      });
    }
    for (const skill of Array.isArray(row.skills) ? row.skills : []) {
      skills.push(String(skill));
      grantCount += 1;
    }
  }
  return { ids, grantCount, skills };
}

/** Read `skills.yaml` and return the slugs plus any row whose `_porting` block is incomplete. */
function readSkills(
  filePath: string,
  problems: VerifyProblem[],
): { slugs: string[] } {
  const doc = asRecord(parseYaml(readFileSync(filePath, "utf8")));
  const rows = asRecordList(doc.skills);
  // 空列表不算问题：只带专家的合法包，skills 就是空的。三类全空的判定在 verifyOutDir。
  const slugs: string[] = [];
  for (const row of rows) {
    const slug = typeof row.slug === "string" ? row.slug : "";
    if (slug === "") {
      problems.push({ file: "skills.yaml", detail: "存在没有 slug 的 skill" });
      continue;
    }
    slugs.push(slug);
    if (
      typeof row.instructions !== "string" ||
      row.instructions.trim() === ""
    ) {
      problems.push({
        file: "skills.yaml",
        detail: `${slug} 的 instructions 为空`,
      });
    }
    if (!Array.isArray(row.tools) || (row.tools as unknown[]).length !== 0) {
      problems.push({
        file: "skills.yaml",
        detail: `${slug} 的 tools 在 P0 必须是空数组`,
      });
    }
    const porting = asRecord(row._porting);
    const runnable = porting.runnable;
    if (
      runnable !== "full" &&
      runnable !== "degraded" &&
      runnable !== "blocked"
    ) {
      problems.push({
        file: "skills.yaml",
        detail: `${slug} 的 _porting.runnable 非法：${String(runnable)}`,
      });
    }
    for (const field of ["source", "source_url", "checksum_sha256"]) {
      if (
        typeof porting[field] !== "string" ||
        String(porting[field]).trim() === ""
      ) {
        problems.push({
          file: "skills.yaml",
          detail: `${slug} 的 _porting.${field} 缺失`,
        });
      }
    }
  }
  return { slugs };
}

/** Read `teams.yaml` and check every referenced agent exists. */
function readTeams(
  filePath: string,
  agentIds: ReadonlySet<string>,
  problems: VerifyProblem[],
): number {
  const doc = asRecord(parseYaml(readFileSync(filePath, "utf8")));
  const rows = asRecordList(doc.teams);
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    const lead = typeof row.lead === "string" ? row.lead : "";
    if (lead === "" || !agentIds.has(lead)) {
      problems.push({
        file: "teams.yaml",
        detail: `${id} 的 lead "${lead}" 不在 agents.yaml 里`,
      });
    }
    const members = asRecordList(row.members);
    if (members.length === 0) {
      problems.push({ file: "teams.yaml", detail: `${id} 没有 members` });
    }
    for (const member of members) {
      const memberId = typeof member.id === "string" ? member.id : "";
      if (!agentIds.has(memberId)) {
        problems.push({
          file: "teams.yaml",
          detail: `${id} 的成员 "${memberId}" 不在 agents.yaml 里`,
        });
      }
    }
    for (const grant of asRecordList(row.address)) {
      const from = typeof grant.from === "string" ? grant.from : "";
      if (!agentIds.has(from)) {
        problems.push({
          file: "teams.yaml",
          detail: `${id} 的 address.from "${from}" 不在 agents.yaml 里`,
        });
      }
      for (const to of Array.isArray(grant.to) ? grant.to : []) {
        if (!agentIds.has(String(to))) {
          problems.push({
            file: "teams.yaml",
            detail: `${id} 的 address.to "${String(to)}" 不在 agents.yaml 里`,
          });
        }
      }
    }
  }
  return rows.length;
}

/** Read `connectors.yaml` and check each host against its url. */
function readConnectors(filePath: string, problems: VerifyProblem[]): string[] {
  const doc = asRecord(parseYaml(readFileSync(filePath, "utf8")));
  const rows = asRecordList(doc.connectors);
  const ids: string[] = [];
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    const url = typeof row.url === "string" ? row.url : "";
    const host = typeof row.host === "string" ? row.host : "";
    ids.push(id);
    let parsedHost: string;
    try {
      parsedHost = new URL(url).host;
    } catch {
      problems.push({
        file: "connectors.yaml",
        detail: `${id} 的 url 无法解析：${url}`,
      });
      continue;
    }
    if (parsedHost !== host) {
      problems.push({
        file: "connectors.yaml",
        detail: `${id} 的 host "${host}" 与 url 的 "${parsedHost}" 不一致`,
      });
    }
    for (const field of [
      "title",
      "vendor",
      "auth",
      "credential_env",
      "source_url",
    ]) {
      if (typeof row[field] !== "string" || String(row[field]).trim() === "") {
        problems.push({
          file: "connectors.yaml",
          detail: `${id} 的 ${field} 缺失`,
        });
      }
    }
  }
  return ids;
}

/**
 * Read the `agents/` directory beside `agents.yaml` (the PackageAgentFile convention P2 uses) and
 * return the ids and skill grants declared there.
 *
 * A file may hold one coworker on its own or a list under `agents:`; only `.yaml`/`.yml` are read,
 * sorted by filename so a refusal names the same file on every machine. Absent directory is a
 * package that keeps every coworker in `agents.yaml`.
 */
function readAgentDirectory(
  outDir: string,
  problems: VerifyProblem[],
): { ids: string[]; skills: string[] } {
  const directory = join(outDir, "agents");
  if (!existsSync(directory)) {
    return { ids: [], skills: [] };
  }
  const ids: string[] = [];
  const skills: string[] = [];
  const filenames = readdirSync(directory)
    .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
    .sort();
  for (const filename of filenames) {
    const source = `agents/${filename}`;
    const doc = asRecord(
      parseYaml(readFileSync(join(directory, filename), "utf8")),
    );
    const rows = doc.agents === undefined ? [doc] : asRecordList(doc.agents);
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : "";
      if (id === "") {
        problems.push({ file: source, detail: "存在没有 id 的 agent" });
        continue;
      }
      ids.push(id);
      if (
        typeof row.system_prompt !== "string" ||
        row.system_prompt.trim() === ""
      ) {
        problems.push({ file: source, detail: `${id} 的 system_prompt 为空` });
      }
      for (const skill of Array.isArray(row.skills) ? row.skills : []) {
        skills.push(String(skill));
      }
    }
  }
  return { ids, skills };
}

/**
 * The §6.4.1 stamp: `capability-manifest.yaml`'s first line and `tool-ref-audit.md`'s header must
 * both carry the same `audit_rules_sha256`.
 *
 * Both checks read RAW TEXT — `parseYaml` drops comments, so a parsed check would silently pass a
 * file whose stamp was stripped by a formatter. The manifest's check anchors to the first line
 * (fail-closed: optional metadata equals no metadata), the report's to its own header line. A BOM
 * is stripped first; the sources already have that precedent.
 */
function verifyAuditRulesStamps(
  outDir: string,
  problems: VerifyProblem[],
): void {
  const expected = auditRulesSha256();
  const manifestRaw = readFileSync(
    join(outDir, "capability-manifest.yaml"),
    "utf8",
  ).replace(/^\uFEFF/, "");
  const manifestFirstLine = manifestRaw.split(/\r?\n/, 1)[0] ?? "";
  const manifestMatch = /^# audit_rules_sha256: ([0-9a-f]{64})/.exec(
    manifestFirstLine,
  );
  if (!manifestMatch) {
    problems.push({
      file: "capability-manifest.yaml",
      detail: "首行缺少 audit_rules_sha256 注释（可选的元数据等于没有元数据）",
    });
  } else if (manifestMatch[1] !== expected) {
    problems.push({
      file: "capability-manifest.yaml",
      detail: `首行 audit_rules_sha256 ${manifestMatch[1]} 与当前规则集 ${expected} 不一致`,
    });
  }
  const auditRaw = readFileSync(
    join(outDir, "tool-ref-audit.md"),
    "utf8",
  ).replace(/^\uFEFF/, "");
  const auditMatch = /^audit_rules_sha256: ([0-9a-f]{64})$/m.exec(auditRaw);
  if (!auditMatch) {
    problems.push({
      file: "tool-ref-audit.md",
      detail: "头部缺少 audit_rules_sha256 行",
    });
  } else if (auditMatch[1] !== expected) {
    problems.push({
      file: "tool-ref-audit.md",
      detail: `头部 audit_rules_sha256 ${auditMatch[1]} 与当前规则集 ${expected} 不一致`,
    });
  }
}

/**
 * Re-read an emitted directory and check it against the contract.
 *
 * Checks the things a schema cannot: that an agent's skill grants resolve, that a team's members exist,
 * that a connector's host matches its url, that the manifest row count equals what the four lists
 * actually contain, and that the audit-rule stamps (§6.4.1) survive in both files that carry them.
 */
export function verifyOutDir(outDir: string): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  for (const file of [...EMITTED_YAML_FILES, ...EMITTED_REPORT_FILES]) {
    if (!existsSync(join(outDir, file))) {
      problems.push({ file, detail: "文件不存在" });
    }
  }
  if (problems.length > 0) {
    return problems;
  }
  const agents = readAgents(join(outDir, "agents.yaml"), problems);
  // Coworkers may also live one per file under `agents/` (P2's package layout); every check below
  // sees the union, so a team naming a directory-declared agent verifies the same way.
  const directoryAgents = readAgentDirectory(outDir, problems);
  const agentIds = [...agents.ids, ...directoryAgents.ids];
  const agentSkillGrants = [...agents.skills, ...directoryAgents.skills];
  const skills = readSkills(join(outDir, "skills.yaml"), problems);
  const teamCount = readTeams(
    join(outDir, "teams.yaml"),
    new Set(agentIds),
    problems,
  );
  const connectorIds = readConnectors(
    join(outDir, "connectors.yaml"),
    problems,
  );
  verifyAuditRulesStamps(outDir, problems);

  // 只要求“三类不全空”：读取端（readWorkBuddy）本来就允许任何一类缺席，只带专家或只带技能的
  // 包是合法产物；三类全空才说明这份输出什么能力都没有，等于什么都没移植。
  if (
    agents.ids.length === 0 &&
    skills.slugs.length === 0 &&
    connectorIds.length === 0
  ) {
    problems.push({
      file: "agents.yaml",
      detail:
        "agents/skills/connectors 三类条目全空——这份输出没有任何能力，等于什么都没移植",
    });
  }

  const skillSlugs = new Set(skills.slugs);
  for (const slug of agentSkillGrants) {
    if (!skillSlugs.has(slug)) {
      problems.push({
        file: "agents.yaml",
        detail: `skills[] 引用了不存在的技能：${slug}`,
      });
    }
  }

  const manifestDoc = parseYaml(
    readFileSync(join(outDir, "capability-manifest.yaml"), "utf8"),
  );
  const manifestRows = asRecordList(manifestDoc);
  if (!Array.isArray(manifestDoc)) {
    problems.push({
      file: "capability-manifest.yaml",
      detail: "根节点必须是序列",
    });
  }
  const violations = validateManifest(
    manifestRows.map(
      (row) => row as unknown as Parameters<typeof validateManifest>[0][number],
    ),
  );
  for (const violation of violations) {
    problems.push({
      file: "capability-manifest.yaml",
      detail: `第 ${violation.index + 1} 行 ${violation.slug}.${violation.field}：${violation.problem}`,
    });
  }
  const expectedRows =
    agentIds.length + skills.slugs.length + teamCount + connectorIds.length;
  if (manifestRows.length !== expectedRows) {
    problems.push({
      file: "capability-manifest.yaml",
      detail: `条目数 ${manifestRows.length} 与清单合计 ${expectedRows} 不一致`,
    });
  }
  const kinds = new Map<string, number>();
  for (const row of manifestRows) {
    const kind = String(row.kind);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const expectation: [string, number][] = [
    ["agent", agentIds.length],
    ["skill", skills.slugs.length],
    ["team", teamCount],
    ["connector", connectorIds.length],
  ];
  for (const [kind, count] of expectation) {
    if ((kinds.get(kind) ?? 0) !== count) {
      problems.push({
        file: "capability-manifest.yaml",
        detail: `kind=${kind} 的条目数 ${kinds.get(kind) ?? 0} 与 ${count} 不一致`,
      });
    }
  }
  return problems;
}
