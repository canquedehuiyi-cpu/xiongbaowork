/**
 * The census is the P1 acceptance artifact, so the tests here pin the two things that would make it lie:
 * a wrong verdict per transport, and a summary that disagrees with its own rows.
 *
 * The fixture is a miniature marketplace on disk — one entry per transport shape, plus the two auth
 * anomalies that actually occur in the real catalogue (`mcp` written into `auth_mode`, and an id with no
 * directory at all) — because the whole point of the survey is that it reads files rather than trusting
 * the index.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const BOM = "\uFEFF";

import {
  AUTH_MODE_MAP,
  assertCensusConsistent,
  buildCensus,
  type Census,
  type CensusRow,
  CensusError,
  formatCensusCounts,
  judgeConnector,
  mapAuthMode,
  renderCensus,
} from "./census";

const root = mkdtempSync(join(tmpdir(), "port-capabilities-census-"));

/** Write a file, creating parents. */
function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

/** One catalogue row, with only the fields the survey reads. */
function catalogueRow(id: string, type: string | undefined, authMode: string | undefined): Record<string, unknown> {
  const row: Record<string, unknown> = { id, name: id };
  if (type !== undefined) {
    row.type = type;
  }
  if (authMode !== undefined) {
    row.auth_mode = authMode;
  }
  return row;
}

/** The catalogue the whole file runs against, written once. */
function writeFixture(): void {
  const rows = [
    catalogueRow("remote-open", "mcp", "oauth"),
    catalogueRow("remote-token", "mcp", "token"),
    catalogueRow("remote-oneid", "mcp", "oneid-token"),
    catalogueRow("remote-server-side", "mcp", "server-side"),
    catalogueRow("remote-bare", "mcp", undefined),
    catalogueRow("remote-anomaly", "mcp", "mcp"),
    catalogueRow("local-stdio", "mcp", undefined),
    catalogueRow("cli-only", "cli", "token"),
    catalogueRow("orphan", "mcp", undefined),
    catalogueRow("remote-bom", "mcp", "oauth"),
  ];
  // 清单文件带 UTF-8 BOM：真实机器上的 connectors.json 确实带过（read-workbuddy 的 stripBom 注释有先例）。
  write(
    "connectors-marketplace/.codebuddy-connector/connectors.json",
    BOM + JSON.stringify({ name: "fixture", connectors: rows }, null, 2),
  );
  write(
    "connectors-marketplace/connectors/remote-open/mcp.json",
    JSON.stringify({ mcpServers: { "remote-open": { url: "https://example.test/mcp" } } }),
  );
  write(
    "connectors-marketplace/connectors/remote-token/mcp.json",
    JSON.stringify({ mcpServers: { "remote-token": { url: "https://example.test/token" } } }),
  );
  write(
    "connectors-marketplace/connectors/remote-oneid/mcp.json",
    JSON.stringify({ mcpServers: { "remote-oneid": { url: "https://example.test/oneid" } } }),
  );
  write(
    "connectors-marketplace/connectors/remote-server-side/mcp.json",
    JSON.stringify({ mcpServers: { "remote-server-side": { url: "https://example.test/ss" } } }),
  );
  write(
    "connectors-marketplace/connectors/remote-bare/mcp.json",
    JSON.stringify({ mcpServers: { "remote-bare": { url: "https://example.test/bare" } } }),
  );
  write(
    "connectors-marketplace/connectors/remote-anomaly/mcp.json",
    JSON.stringify({ mcpServers: { "remote-anomaly": { url: "https://example.test/anomaly" } } }),
  );
  write(
    "connectors-marketplace/connectors/local-stdio/mcp.json",
    JSON.stringify({ mcpServers: { "local-stdio": { command: "npx", args: ["-y", "some-server"] } } }),
  );
  write(
    "connectors-marketplace/connectors/cli-only/cli.json",
    JSON.stringify({ name: "cli-only", binary: "cli-only" }),
  );
  // remote-bom 的 mcp.json 带 UTF-8 BOM：JSON.parse 拒绝 BOM，剥掉之前会被误判成无法解析的 stdio。
  write(
    "connectors-marketplace/connectors/remote-bom/mcp.json",
    BOM + JSON.stringify({ mcpServers: { "remote-bom": { url: "https://example.test/bom" } } }),
  );
  // `orphan` deliberately has no directory: the index claims a connector the disk does not have.
}

writeFixture();

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The census under test, built once from the fixture. */
const census = buildCensus(root);

/** One row by id, or a failure that names the id. */
function row(id: string): CensusRow {
  const found = census.rows.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no row ${id}`);
  }
  return found;
}

describe("auth_mode mapping", () => {
  test("every mapping in the table is one of openbot's three models or the explicit unknown", () => {
    for (const [raw, mapped] of Object.entries(AUTH_MODE_MAP)) {
      expect(["none", "user-oauth", "deployment-bearer", "unknown"]).toContain(mapped);
      // `tenant-credential` is the name this repo used to invent; it must not come back as a second name
      // for the same concept.
      expect(raw).not.toBe("tenant-credential");
    }
  });

  test("the deployment-held token has one name, whichever way WorkBuddy spells it", () => {
    expect(mapAuthMode("token")).toBe("deployment-bearer");
    expect(mapAuthMode("oneid-token")).toBe("deployment-bearer");
  });

  test("a value nobody has mapped is unknown, not guessed", () => {
    expect(mapAuthMode("oauth")).toBe("user-oauth");
    expect(mapAuthMode("(absent)")).toBe("none");
    expect(mapAuthMode("mcp")).toBe("unknown");
    expect(mapAuthMode("something-new")).toBe("unknown");
  });

  test("server-side 映射为 deployment-bearer，verdict 判 degraded（platform-held-credential）", () => {
    // 反向反证：第一条断言在映射被改回 "none"（"凭据在服务端、客户端无需注入"的旧读法）时立即变红。
    // 该读法已被实测推翻：tdx-connector / ezr-crm / fazhi-law 三个 server-side 连接器不带凭据直接调
    // MCP initialize，全部 401。server-side 的真实语义是平台代持凭据并逐请求注入 Bearer。
    expect(AUTH_MODE_MAP).toHaveProperty("server-side", "deployment-bearer");
    expect(mapAuthMode("server-side")).toBe("deployment-bearer");
    const serverSide = row("remote-server-side");
    expect(serverSide.auth_mode_raw).toBe("server-side");
    expect(serverSide.verdict).toBe("degraded");
    expect(serverSide.reason).toContain("platform-held-credential");
  });
});

describe("transport is decided by the files, not by the index", () => {
  test("a url server, a stdio server, a CLI wrapper and a missing directory are told apart", () => {
    expect(row("remote-open").transport).toBe("mcp-url");
    expect(row("local-stdio").transport).toBe("mcp-command");
    expect(row("cli-only").transport).toBe("cli");
    expect(row("orphan").transport).toBe("missing");
  });

  test("带 UTF-8 BOM 的 mcp.json 仍按内容判定传输方式，不会被误判成 mcp-command", () => {
    expect(row("remote-bom").transport).toBe("mcp-url");
    expect(row("remote-bom").verdict).toBe("full");
  });

  test("the directory cell points at the spec file, and never at an absolute path", () => {
    expect(row("remote-open").directory).toBe("connectors/remote-open/mcp.json");
    expect(row("cli-only").directory).toBe("connectors/cli-only/cli.json");
    expect(row("orphan").directory).toContain("connectors/orphan");
    for (const entry of census.rows) {
      expect(entry.directory.startsWith("/")).toBe(false);
      expect(entry.directory.includes(root)).toBe(false);
    }
  });

  test("the declared type is kept beside the shipped one, so a mismatch stays visible", () => {
    expect(row("cli-only").declared_type).toBe("cli");
    expect(row("remote-bare").auth_mode_raw).toBe("(absent)");
  });
});

describe("verdict", () => {
  test("a remote server with a mapped credential model is full", () => {
    expect(row("remote-open").verdict).toBe("full");
    expect(row("remote-token").verdict).toBe("full");
    expect(row("remote-bare").auth_mode_mapped).toBe("none");
    expect(row("remote-bare").verdict).toBe("full");
  });

  test("a remote server whose credential model is unmapped is degraded, and says so", () => {
    const anomaly = row("remote-anomaly");
    expect(anomaly.auth_mode_raw).toBe("mcp");
    expect(anomaly.auth_mode_mapped).toBe("unknown");
    expect(anomaly.verdict).toBe("degraded");
    expect(anomaly.reason).toContain("auth_mode");
  });

  test("anything that needs a local runtime is blocked, and the reason names the missing piece", () => {
    for (const id of ["local-stdio", "cli-only", "orphan"]) {
      expect(row(id).verdict).toBe("blocked");
      expect(row(id).reason.length).toBeGreaterThan(0);
    }
    expect(row("local-stdio").reason).toContain("stdio");
    expect(row("cli-only").reason).toContain("CLI");
    expect(row("orphan").reason).toContain("server");
  });

  test("judgeConnector is total: every transport yields one of the three levels", () => {
    for (const transport of ["mcp-url", "mcp-command", "cli", "missing"] as const) {
      for (const auth of ["none", "user-oauth", "deployment-bearer", "unknown"] as const) {
        const { verdict, reason } = judgeConnector(transport, auth);
        expect(["full", "degraded", "blocked"]).toContain(verdict);
        expect(reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("counts", () => {
  test("the cross table and the summary are both tallied from the same rows", () => {
    expect(census.counts.total).toBe(census.rows.length);
    expect(census.counts.by_verdict.full + census.counts.by_verdict.degraded + census.counts.by_verdict.blocked).toBe(
      census.counts.total,
    );
    expect(census.cross_table.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(census.counts.total);
  });

  test("a summary that disagrees with its rows is a hard failure", () => {
    // The exit-1 path: a report whose headline number cannot be reproduced from its own rows is worse than
    // no report, because it is believed.
    const tampered: Census = {
      ...census,
      counts: { ...census.counts, by_verdict: { ...census.counts.by_verdict, blocked: census.counts.by_verdict.blocked - 1 } },
    };
    expect(() => assertCensusConsistent(tampered)).toThrow(CensusError);
  });

  test("a cross table row that disagrees with by_transport is a hard failure", () => {
    const tampered: Census = {
      ...census,
      cross_table: census.cross_table.map((bucket, index) =>
        index === 0 ? { ...bucket, total: bucket.total + 1 } : bucket,
      ),
    };
    expect(() => assertCensusConsistent(tampered)).toThrow(CensusError);
  });

  test("the summary line names all three levels", () => {
    expect(formatCensusCounts(census)).toMatch(/^full \d+ \/ degraded \d+ \/ blocked \d+$/);
  });
});

describe("renderCensus", () => {
  test("parses back to the same numbers and is byte-identical across calls", () => {
    const first = renderCensus(census);
    expect(renderCensus(census)).toBe(first);
    const parsed = parseYaml(first);
    expect(parsed.counts.total).toBe(census.counts.total);
    expect(parsed.rows.length).toBe(census.rows.length);
    expect(parsed.source_index_checksum).toBe(census.source_index_checksum);
  });

  test("the header says what generated_at means, because it is not the run time", () => {
    expect(renderCensus(census)).toContain("generated_at 取清单文件自身的写入时间");
  });

  test("the checksum changes when the catalogue changes", () => {
    write("connectors-marketplace/connectors/extra/mcp.json", JSON.stringify({ url: "https://example.test/x" }));
    write(
      "connectors-marketplace/.codebuddy-connector/connectors.json",
      JSON.stringify({ connectors: [...JSON.parse(JSON.stringify(census.rows)), catalogueRow("extra", "mcp", "token")] }),
    );
    const changed = buildCensus(root);
    expect(changed.source_index_checksum).not.toBe(census.source_index_checksum);
    expect(changed.counts.total).toBe(census.counts.total + 1);
    // Restore the fixture so the order of the file's tests cannot matter.
    writeFixture();
  });
});
