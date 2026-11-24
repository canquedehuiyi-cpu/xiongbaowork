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

const script = join(import.meta.dir, "prod-inspect.sh");

// 假 docker：`inspect` 按环境变量成败；`ls`/`df` 返回预置结果；`sh -c`（psql 会话）把标准输入
// 存成 sql/N.sql 并按最后一条 SQL 的种类返回预置结果。FAKE_PSQL_FAIL 时模拟 psql 报错并在标准错误里
// 带一段「值」，用来证明报错内容不会漏进报告。
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
      ls)
        printf 'OPENBOT_PUBLIC_URL\\nXIONGBAO_RLS_ENFORCE\\nCOPILOTKIT_REMOTE_URL\\nPATH\\nMIGRATION_DATABASE_URL\\n'
        [ -n "\${FAKE_LS_WEB_BOT_AUTH:-}" ] && echo WEB_BOT_AUTH ;;
      df)
        printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\\n/dev/vdb 1000 400 600 40%% /var/lib/postgresql\\n' ;;
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
          "SELECT count(*)"*) echo 7 ;;
          "SELECT rolname"*) printf 'openbot\\nopenbot_app\\n' ;;
          "SELECT datname"*) echo openbot ;;
          "SELECT proname"*) echo openbot_touch ;;
          "SELECT tgname"*) echo openbot_trg ;;
          "SELECT pg_database_size"*) echo 123456 ;;
          *) echo "unexpected sql: $last" >&2; exit 1 ;;
        esac ;;
      *) echo "unexpected exec: $*" >&2; exit 1 ;;
    esac ;;
  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
`;

let dir: string;
let envFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prod-inspect-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "docker"), FAKE_DOCKER);
  chmodSync(join(dir, "bin", "docker"), 0o755);
  envFile = join(dir, ".env.delivery");
  writeFileSync(
    envFile,
    "OPENBOT_PUBLIC_URL=http://x\nXIONGBAO_RLS_ENFORCE=warn\nKEY_ENCRYPTION_KEY=abc\nCOPILOTKIT_API_KEY=ck-secret\nCPK_DEBUG=1\n",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(extraEnv: Record<string, string> = {}, args = ["c1", envFile]) {
  const result = Bun.spawnSync(["sh", script, ...args], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      FAKE_DIR: dir,
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

describe("prod-inspect.sh", () => {
  test("report contains only names and counts", () => {
    const { code, out } = run();
    expect(code).toBe(0);
    // 值只能是纯数字；`=n/a` 留给不入库、无法用 count(*) 回答的项
    const shape = /^(# .*|[A-Za-z0-9_.:-]+(=([0-9]+|n\/a))?|)$/;
    for (const line of out.split("\n")) expect(line).toMatch(shape);
    expect(out).toContain("approvals_pending=7");
    expect(out).toContain("run_assertions_unexpired=n/a");
    expect(out).toContain("pg_volume_avail_kb=600");
    expect(out).toContain("openbot_app");
  });

  test("every SQL statement is a count or a catalog name query", () => {
    run();
    const all = sessions();
    expect(all.length).toBeGreaterThan(10);
    for (const lines of all) {
      expect(lines[0]).toStartWith("SET default_transaction_read_only = on");
      expect(lines.length).toBe(2);
      expect(lines[1]).toMatch(
        /^SELECT (count\(\*\)|rolname|datname|proname|tgname|pg_size_pretty|pg_database_size)/,
      );
    }
  });

  test("env names are listed without values", () => {
    const { out } = run();
    expect(out).toContain("OPENBOT_PUBLIC_URL");
    expect(out).toContain("XIONGBAO_RLS_ENFORCE");
    expect(out).not.toContain("http://x");
    expect(out).not.toContain("warn");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("ck-secret");
    expect(out).not.toContain("KEY_ENCRYPTION_KEY");
    expect(out).not.toContain("MIGRATION_DATABASE_URL");
    expect(out).toContain("copilotkit_env_file=2");
    expect(out).toContain("copilotkit_container_env=1");
  });

  test("connection string is read inside the container and never put in an argument", () => {
    run();
    const args = readFileSync(join(dir, "args.log"), "utf8");
    expect(args).toContain("PGPASSWORD");
    expect(args).not.toContain("PGPASSFILE");
    expect(args).not.toContain('psql "$(cat');
    expect(args).not.toMatch(/postgres(ql)?:\/\/[^ ]*@/);
  });

  test("password reaches psql only through its environment and leaves no file behind", () => {
    const work = join(dir, "work");
    const tmp = join(dir, "tmp");
    mkdirSync(work);
    mkdirSync(tmp);
    writeFileSync(
      join(work, "url"),
      "postgres://svcuser:pw-s3cret-9@db.internal:6543/appdb",
    );
    writeFileSync(
      join(work, "psql"),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_DIR/psql.argv"\nprintf \'%s\' "$PGPASSWORD" > "$FAKE_DIR/psql.pgpassword"\ncat > /dev/null\necho 5\n',
    );
    chmodSync(join(work, "psql"), 0o755);
    const { code, out } = run({
      FAKE_REAL_SH: "1",
      PROD_INSPECT_URL_FILE: join(work, "url"),
      PROD_INSPECT_PSQL: join(work, "psql"),
      TMPDIR: tmp,
    });
    expect(code).toBe(0);
    expect(out).toContain("approvals_pending=5");
    const argv = readFileSync(join(dir, "psql.argv"), "utf8");
    expect(argv).not.toContain("pw-s3cret-9");
    expect(argv).not.toContain("postgres://");
    expect(argv).toContain("db.internal");
    expect(argv).toContain("6543");
    expect(argv).toContain("svcuser");
    expect(argv).toContain("appdb");
    expect(readFileSync(join(dir, "psql.pgpassword"), "utf8")).toBe(
      "pw-s3cret-9",
    );
    expect(out).not.toContain("pw-s3cret-9");
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("env file names tolerate leading blanks and export, and repeats count once", () => {
    writeFileSync(
      envFile,
      "  OPENBOT_A=1\nexport XIONGBAO_B=2\n\texport  CPK_C=3\nCPK_C=4\nCOPILOTKIT_D=5\n#OPENBOT_COMMENTED=1\n",
    );
    const { out } = run();
    const section = out.split("\n# container-env")[0] ?? "";
    for (const name of ["OPENBOT_A", "XIONGBAO_B", "CPK_C", "COPILOTKIT_D"]) {
      expect(section.split("\n")).toContain(name);
    }
    expect(section).not.toContain("export");
    expect(section).not.toContain("COMMENTED");
    expect(out).toContain("copilotkit_env_file=2");
  });

  test("web_bot_auth_env_named reports presence of the name only", () => {
    expect(run().out).toContain("web_bot_auth_env_named=0");
    writeFileSync(envFile, "WEB_BOT_AUTH=on-value-xyz\n");
    const fromFile = run().out;
    expect(fromFile).toContain("web_bot_auth_env_named=1");
    expect(fromFile).not.toContain("on-value-xyz");
    writeFileSync(envFile, "OPENBOT_X=1\n");
    const fromContainer = run({ FAKE_LS_WEB_BOT_AUTH: "1" }).out;
    expect(fromContainer).toContain("web_bot_auth_env_named=1");
  });

  test("a failing query prints n/a and never echoes the database error", () => {
    const { code, out, err } = run({ FAKE_PSQL_FAIL: "1" });
    expect(code).toBe(0);
    expect(out).toContain("approvals_pending=n/a");
    expect(out + err).not.toContain("s3cretvalue");
  });

  test("missing container exits 2 with a hint", () => {
    const { code, err } = run({ FAKE_NO_CONTAINER: "1" });
    expect(code).toBe(2);
    expect(err).toContain("docker ps");
  });

  test("missing env file exits 2", () => {
    const { code } = run({}, ["c1", join(dir, "nope")]);
    expect(code).toBe(2);
  });
});
