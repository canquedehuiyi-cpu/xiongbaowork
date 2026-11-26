import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * pre-upgrade-check.sh 的逻辑测试：假 docker 按 SQL 里的表名返回预置数字。真库上的同一套查询由
 * docker/tests/rebrand-preflight.test.sh 跑（它用 initdb 起的真集群，CI 在交付镜像里执行）。
 */
const script = join(import.meta.dir, "pre-upgrade-check.sh");
const prodInspect = join(import.meta.dir, "prod-inspect.sh");
const preflight = join(
  import.meta.dir,
  "..",
  "..",
  "docker",
  "s6",
  "scripts",
  "rebrand-preflight.sh",
);

// 假 docker：inspect 按 FAKE_NO_CONTAINER 成败；`exec C test -s <URL 文件>` 按 FAKE_NO_URL 成败；
// `exec C test -e <进行中记录>` 按 FAKE_MARKER 成败；`exec C df` 返回 FAKE_AVAIL_KB；`exec -i C sh -c …` 把标准输入存成 sql/N.sql，按语句里的表名回答。
const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DIR/args.log"
case "$1" in
  inspect)
    [ -n "\${FAKE_NO_CONTAINER:-}" ] && { echo "Error: No such object" >&2; exit 1; }
    exit 0 ;;
  exec)
    shift
    [ "$1" = "-i" ] && shift
    shift
    case "$1" in
      test)
        case "$*" in
          *rebrand-in-progress*) [ -n "\${FAKE_MARKER:-}" ] ;;
          *) [ -z "\${FAKE_NO_URL:-}" ] ;;
        esac ;;
      df)
        printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\\n/dev/vdb 99999999 400 %s 40%% /var/lib/postgresql\\n' "$FAKE_AVAIL_KB" ;;
      sh)
        if [ -n "\${FAKE_REAL_SH:-}" ]; then shift; exec sh "$@"; fi
        mkdir -p "$FAKE_DIR/sql"
        n=$(ls "$FAKE_DIR/sql" | wc -l)
        n=$((n + 1))
        cat > "$FAKE_DIR/sql/$n.sql"
        if [ -n "\${FAKE_PSQL_FAIL:-}" ]; then
          echo "ERROR: invalid input syntax for value postgres://openbot:s3cretvalue@h/db" >&2
          exit 1
        fi
        last=$(tail -n 1 "$FAKE_DIR/sql/$n.sql")
        case "$last" in
          *pg_roles*) echo "$FAKE_ROLES" ;;
          *pg_tables*approval_continuation*)
            if [ -n "\${FAKE_NO_CONTINUATION_TABLES:-}" ]; then echo 0; else echo 1; fi ;;
          *pg_tables*) echo 1 ;;
          *approval_requests*) echo "$FAKE_PENDING" ;;
          *approval_continuation_steps*) echo "$FAKE_STEPS" ;;
          *approval_continuations*) echo "$FAKE_CONTINUATIONS" ;;
          *pg_database_size*) echo "$FAKE_SIZE" ;;
          *) echo "unexpected sql: $last" >&2; exit 1 ;;
        esac ;;
      *) echo "unexpected exec: $*" >&2; exit 1 ;;
    esac ;;
  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
`;

const MB = 1024 * 1024;
// 京东云 2026-11-24 实测：库 107MB，卷可用 37GB，在途为 0。
const CLEAN = {
  FAKE_ROLES: "2",
  FAKE_PENDING: "0",
  FAKE_CONTINUATIONS: "0",
  FAKE_STEPS: "0",
  FAKE_SIZE: String(107 * MB),
  FAKE_AVAIL_KB: String(37 * 1024 * 1024),
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pre-upgrade-check-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "docker"), FAKE_DOCKER);
  chmodSync(join(dir, "bin", "docker"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(extraEnv: Record<string, string> = {}, args = ["xiongbao"]) {
  const result = Bun.spawnSync(["sh", script, ...args], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      FAKE_DIR: dir,
      ...CLEAN,
      ...extraEnv,
    },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

function sessions() {
  const sqlDir = join(dir, "sql");
  return readdirSync(sqlDir)
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((name) =>
      readFileSync(join(sqlDir, name), "utf8").split("\n").filter(Boolean),
    );
}

/** prod-inspect.sh 里 `count <名字> "<SQL>"` 那一行的 SQL。 */
function inspectQuery(name: string): string {
  const line = readFileSync(prodInspect, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`count ${name} "`));
  if (!line) throw new Error(`prod-inspect.sh has no count ${name}`);
  return line.slice(`count ${name} "`.length, -1);
}

const IN_FLIGHT = [
  "approvals_pending",
  "continuations_unfinished",
  "continuation_steps_unfinished",
];

describe("pre-upgrade-check.sh", () => {
  test("a server with nothing in flight and room for the backup is a go", () => {
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain("需要改名：是");
    expect(out).toContain("待审批：0");
    expect(out).toContain("未完成的续跑：0");
    expect(out).toContain("未完成的续跑步骤：0");
    expect(out).toContain("运行断言");
    expect(out).toContain("数据库大小：107 MB");
    expect(out).toContain("备份需要可用空间：至少 214 MB");
    expect(out).toContain("结论：可以升级");
    expect(out).not.toContain("暂不能升级");
  });

  test("pending approvals or unfinished continuations are a no-go with the counts", () => {
    const pending = run({ FAKE_PENDING: "3" });
    expect(pending.code).toBe(1);
    expect(pending.out).toContain("待审批：3");
    expect(pending.out).toContain("结论：暂不能升级");
    expect(pending.out).toContain("批准或拒绝");
    for (const env of [{ FAKE_CONTINUATIONS: "1" }, { FAKE_STEPS: "2" }]) {
      const { code, out } = run(env);
      expect(code).toBe(1);
      expect(out).toContain("结论：暂不能升级");
    }
  });

  test("too little volume space is a no-go that says how much is needed", () => {
    const { code, out } = run({
      FAKE_SIZE: String(100 * MB),
      FAKE_AVAIL_KB: String(150 * 1024),
    });
    expect(code).toBe(1);
    expect(out).toContain("备份需要可用空间：至少 200 MB");
    expect(out).toContain("数据库卷可用空间：150 MB");
    expect(out).toContain("还差 50 MB");
    expect(out).toContain("结论：暂不能升级");
    // 正好两倍够用
    expect(
      run({ FAKE_SIZE: String(100 * MB), FAKE_AVAIL_KB: String(200 * 1024) })
        .code,
    ).toBe(0);
  });

  test("a volume older than the continuation tables counts them as 0 and says so", () => {
    const { code, out } = run({ FAKE_NO_CONTINUATION_TABLES: "1" });
    expect(code).toBe(0);
    expect(out).toContain("未完成的续跑：0");
    expect(out).toContain("未完成的续跑步骤：0");
    expect(out).toContain("按 0 计");
    expect(out).toContain("approval_continuations");
    expect(out).toContain("结论：可以升级");
    // 表不存在时不去数它
    expect(
      sessions().some((lines) =>
        lines[1]?.startsWith("SELECT count(*) FROM approval_continuations "),
      ),
    ).toBe(false);
  });

  test("a record left by an unfinished v0.2.16 upgrade is a no-go with the command to remove it", () => {
    const { code, out } = run({ FAKE_MARKER: "1" });
    expect(code).toBe(1);
    expect(out).toContain("rebrand-in-progress");
    expect(out).toContain(
      "docker exec xiongbao rm -f /var/lib/postgresql/backup/rebrand-in-progress",
    );
    expect(out).toContain("结论：暂不能升级");
  });

  test("a volume already carrying the new names needs no rename and is a go", () => {
    const { code, out } = run({ FAKE_ROLES: "0" });
    expect(code).toBe(0);
    expect(out).toContain("需要改名：否");
    expect(out).toContain("结论：可以升级");
  });

  test("every session is read-only and asks only for counts and the database size", () => {
    run();
    const all = sessions();
    // 角色、三张表是否存在、三项在途、库大小
    expect(all.length).toBe(8);
    for (const lines of all) {
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe("SET default_transaction_read_only = on;");
      expect(lines[1]).toMatch(
        /^SELECT (count\(\*\) FROM |pg_database_size\()/,
      );
    }
  });

  test("in-flight queries are the ones prod-inspect and the container preflight use", () => {
    run();
    const asked = sessions().map((lines) => lines[1]);
    const preflightSource = readFileSync(preflight, "utf8");
    for (const name of IN_FLIGHT) {
      const query = inspectQuery(name);
      expect(asked).toContain(query);
      expect(preflightSource).toContain(query);
    }
    // 需要改名的判定按 Task 18 的接口：库里存在这两个旧名角色之一。
    expect(asked).toContain(
      "SELECT count(*) FROM pg_roles WHERE rolname IN ('openbot', 'openbot_app');",
    );
  });

  test("no secret value reaches the output or a command-line argument", () => {
    const work = join(dir, "work");
    mkdirSync(work);
    writeFileSync(
      join(work, "url"),
      "postgres://svcuser:pw-s3cret-9@127.0.0.1:5432/appdb",
    );
    writeFileSync(
      join(work, "psql"),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$FAKE_DIR/psql.argv"\nprintf \'%s\' "$PGPASSWORD" > "$FAKE_DIR/psql.pgpassword"\ncat > /dev/null\necho 0\n',
    );
    chmodSync(join(work, "psql"), 0o755);
    const { code, out, err } = run({
      FAKE_REAL_SH: "1",
      PRE_UPGRADE_URL_FILE: join(work, "url"),
      PRE_UPGRADE_PSQL: join(work, "psql"),
    });
    // 假 psql 对每条都答 0：库大小 0、角色 0，照样能给出结论。
    expect(code).toBe(0);
    const argv = readFileSync(join(dir, "psql.argv"), "utf8");
    expect(argv).not.toContain("pw-s3cret-9");
    expect(argv).not.toContain("postgres://");
    expect(readFileSync(join(dir, "psql.pgpassword"), "utf8")).toBe(
      "pw-s3cret-9",
    );
    const args = readFileSync(join(dir, "args.log"), "utf8");
    expect(args).not.toContain("pw-s3cret-9");
    expect(out + err).not.toContain("pw-s3cret-9");
  });

  test("a query that fails is never a go and does not echo the database error", () => {
    const { code, out, err } = run({ FAKE_PSQL_FAIL: "1" });
    expect(code).toBe(2);
    expect(out).toContain("结论：无法确认");
    expect(out).not.toContain("可以升级");
    expect(out + err).not.toContain("s3cretvalue");
  });

  test("a container without the embedded database exits 2 and says why", () => {
    const { code, err } = run({ FAKE_NO_URL: "1" });
    expect(code).toBe(2);
    expect(err).toContain("内置数据库");
  });

  test("missing container exits 2 with a hint", () => {
    const { code, err } = run({ FAKE_NO_CONTAINER: "1" });
    expect(code).toBe(2);
    expect(err).toContain("docker ps");
  });

  test("the container name defaults to xiongbao and is validated", () => {
    run({}, []);
    expect(readFileSync(join(dir, "args.log"), "utf8")).toContain(
      "inspect xiongbao",
    );
    const { code } = run({}, ["bad name;rm"]);
    expect(code).toBe(1);
  });
});
