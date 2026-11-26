import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "rewrite-env.sh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewrite-env-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]) {
  const result = Bun.spawnSync(["sh", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function write(name: string, lines: string[], mode = 0o600) {
  const file = join(dir, name);
  writeFileSync(file, `${lines.join("\n")}\n`);
  chmodSync(file, mode);
  return file;
}

const backups = () => readdirSync(dir).filter((name) => name.includes(".bak-"));

// 京东云 /opt/xiongbao/.env.delivery 的形状（2026-11-24 实测的名字，值是编的）：四个旧名、一个新名，夹着无前缀的行。
const DELIVERY = [
  "EMBEDDED_POSTGRES=on",
  "OPENBOT_SINGLE_USER=false",
  "OPENBOT_PUBLIC_URL=https://work.example.cn",
  "TENANT_PACKAGE_DIR=../examples/xiongbao",
  "OPENBOT_SELF_HOST_BANNER=false",
  "OPENBOT_RLS_ENFORCE=refuse",
  "XIONGBAO_CONTENT_PORT=3773",
  "KEY_ENCRYPTION_KEY=c2VjcmV0LWtleS1tYXRlcmlhbC1ub3QtdG8tcHJpbnQ=",
  "OPENAI_API_KEY=sk-made-up-value-not-to-print",
];

describe("rewrite-env.sh", () => {
  test("renames old lines, keeps a backup, never prints values", () => {
    const file = write(".env.delivery", DELIVERY);
    const before = readFileSync(file, "utf8");
    const { code, stdout, stderr } = run(file);
    expect(code).toBe(0);
    expect(readFileSync(file, "utf8").split("\n")).toEqual([
      "EMBEDDED_POSTGRES=on",
      "XIONGBAO_SINGLE_USER=false",
      "XIONGBAO_PUBLIC_URL=https://work.example.cn",
      "TENANT_PACKAGE_DIR=../examples/xiongbao",
      "XIONGBAO_SELF_HOST_BANNER=false",
      "XIONGBAO_RLS_ENFORCE=refuse",
      "XIONGBAO_CONTENT_PORT=3773",
      "KEY_ENCRYPTION_KEY=c2VjcmV0LWtleS1tYXRlcmlhbC1ub3QtdG8tcHJpbnQ=",
      "OPENAI_API_KEY=sk-made-up-value-not-to-print",
      "",
    ]);
    // 备份是改之前的原样，权限 0600，名字是 <文件>.bak-<UTC 时间>。
    const [backup] = backups();
    expect(backup).toMatch(/^\.env\.delivery\.bak-\d{8}T\d{6}Z$/);
    const backupPath = join(dir, backup as string);
    expect(readFileSync(backupPath, "utf8")).toBe(before);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    // 改写不动原文件的权限。
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // 名字可以出现，值一个都不出现。
    const printed = stdout + stderr;
    for (const value of [
      "work.example.cn",
      "refuse",
      "false",
      "3773",
      "c2VjcmV0",
      "sk-made-up",
    ])
      expect(printed).not.toContain(value);
    expect(printed).toContain("OPENBOT_PUBLIC_URL");
  });

  test("comments out an old line when the new one exists", () => {
    const file = write(".env", [
      "XIONGBAO_PUBLIC_URL=https://new.example",
      "OPENBOT_PUBLIC_URL=https://old.example",
      "OPENBOT_SINGLE_USER=true",
    ]);
    const { code, stdout, stderr } = run(file);
    expect(code).toBe(0);
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines[0]).toBe("XIONGBAO_PUBLIC_URL=https://new.example");
    // 注释掉而不是删掉：旧值还在文件里，看得到、改得回来；运行时本来也是新名赢。
    expect(lines[1]).toMatch(/^# .*OPENBOT_PUBLIC_URL=https:\/\/old\.example$/);
    expect(lines[2]).toBe("XIONGBAO_SINGLE_USER=true");
    expect(stderr).toContain("OPENBOT_PUBLIC_URL");
    expect(stdout + stderr).not.toContain("old.example");
    expect(stdout + stderr).not.toContain("new.example");
  });

  test("the compose variables for image, tag and port are renamed like the rest", () => {
    const file = write(".env.delivery", [
      "OPENBOT_IMAGE=ghcr.io/example/xiongbaowork@sha256:abc",
      "OPENBOT_TAG=v0.2.13",
      "OPENBOT_PORT=3780",
    ]);
    const { code, stderr } = run(file);
    expect(code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      "XIONGBAO_IMAGE=ghcr.io/example/xiongbaowork@sha256:abc\nXIONGBAO_TAG=v0.2.13\nXIONGBAO_PORT=3780\n",
    );
    // 更早的 compose.delivery.yml 只认旧名：改了这两个就得换新 Compose 文件，脚本要说出来。
    expect(stderr).toContain("compose.delivery.yml");
    expect(stderr).not.toContain("sha256:abc");
  });

  test("every line of a repeated old name is renamed, so the last one still wins", () => {
    const file = write(".env", [
      "OPENBOT_EDITION=team",
      "OPENBOT_EDITION=personal",
    ]);
    expect(run(file).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      "XIONGBAO_EDITION=team\nXIONGBAO_EDITION=personal\n",
    );
  });

  test("a platform model key keeps its old name, because the database row names it", () => {
    const file = write(".env", [
      "OPENBOT_POOL_OPENAI=sk-pool",
      "OPENBOT_EDITION=team",
    ]);
    const { code, stdout, stderr } = run(file);
    expect(code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      "OPENBOT_POOL_OPENAI=sk-pool\nXIONGBAO_EDITION=team\n",
    );
    expect(stderr).toContain("OPENBOT_POOL_OPENAI");
    expect(stdout + stderr).not.toContain("sk-pool");
  });

  test("comments, export, indentation and values with = or # are handled as a shell reads them", () => {
    const file = write(".env", [
      "# OPENBOT_TAG=v0.2.13",
      "export OPENBOT_PUBLIC_URL=http://a/?x=1#frag",
      "  OPENBOT_SINGLE_USER=true",
      "OPENBOT_=bare",
    ]);
    expect(run(file).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      "# OPENBOT_TAG=v0.2.13\nexport XIONGBAO_PUBLIC_URL=http://a/?x=1#frag\n  XIONGBAO_SINGLE_USER=true\nOPENBOT_=bare\n",
    );
  });

  test("a file with no old names is left alone and gets no backup", () => {
    const file = write(".env", ["XIONGBAO_PUBLIC_URL=https://new.example"]);
    const { code, stderr } = run(file);
    expect(code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      "XIONGBAO_PUBLIC_URL=https://new.example\n",
    );
    expect(backups()).toEqual([]);
    expect(stderr).not.toContain("new.example");
  });

  test("running it twice changes nothing the second time", () => {
    const file = write(".env.delivery", DELIVERY);
    expect(run(file).code).toBe(0);
    const once = readFileSync(file, "utf8");
    expect(run(file).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(once);
    expect(backups()).toHaveLength(1);
  });

  test("a missing file or argument is refused without writing anything", () => {
    expect(run().code).toBe(2);
    expect(run(join(dir, "nope.env")).code).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a file without a final newline keeps its last line", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "OPENBOT_SINGLE_USER=true");
    expect(run(file).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("XIONGBAO_SINGLE_USER=true\n");
  });
});
