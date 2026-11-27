import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBlock } from "./manual-blocks.mjs";

const script = join(import.meta.dir, "manual-blocks.mjs");
const product = join(import.meta.dir, "..", "..");
const root = join(product, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const manual = readFileSync(
  join(product, "docs", "deployment-xiongbao.md"),
  "utf8",
);
const IMAGE = "ghcr.io/canquedehuiyi-cpu/xiongbaowork";
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function doc(...lines) {
  return `${lines.join("\n")}\n`;
}

function tempFile(name, text) {
  const dir = mkdtempSync(join(tmpdir(), "manual-blocks-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

function cli(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

// --- extraction ---

test("extracts the single fenced block between the markers", () => {
  const text = doc(
    "# Title",
    "```bash",
    "echo outside",
    "```",
    "<!-- demo:begin -->",
    "",
    "```bash",
    "echo one",
    "  echo two",
    "```",
    "",
    "<!-- demo:end -->",
    "after",
  );
  expect(extractBlock(text, "demo")).toEqual({
    lang: "bash",
    body: "echo one\n  echo two\n",
  });
});

test("accepts CRLF, tilde fences and a longer fence holding a shorter one", () => {
  expect(
    extractBlock(
      "<!-- a:begin -->\r\n~~~sh\r\nx\r\n~~~\r\n<!-- a:end -->\r\n",
      "a",
    ),
  ).toEqual({ lang: "sh", body: "x\n" });
  const nested = doc(
    "<!-- a:begin -->",
    "````markdown",
    "```bash",
    "inner",
    "```",
    "````",
    "<!-- a:end -->",
  );
  expect(extractBlock(nested, "a").body).toBe("```bash\ninner\n```\n");
});

test("names with a colon pick only their own markers", () => {
  const text = doc(
    "<!-- g7:windows:begin -->",
    "```powershell",
    "win",
    "```",
    "<!-- g7:windows:end -->",
    "<!-- g7:linux:begin -->",
    "```bash",
    "lin",
    "```",
    "<!-- g7:linux:end -->",
  );
  expect(extractBlock(text, "g7:linux").body).toBe("lin\n");
  expect(extractBlock(text, "g7:windows").body).toBe("win\n");
});

test.each([
  [
    "missing begin marker",
    doc("```bash", "x", "```", "<!-- a:end -->"),
    /Missing marker <!-- a:begin -->/,
  ],
  [
    "missing end marker",
    doc("<!-- a:begin -->", "```bash", "x", "```"),
    /Unterminated block a: missing <!-- a:end -->/,
  ],
  [
    "end before begin",
    doc("<!-- a:end -->", "<!-- a:begin -->", "```bash", "x", "```"),
    /Unterminated block a: <!-- a:end --> before/,
  ],
  [
    "duplicate begin",
    doc(
      "<!-- a:begin -->",
      "```bash",
      "x",
      "```",
      "<!-- a:begin -->",
      "<!-- a:end -->",
    ),
    /Duplicate marker <!-- a:begin -->/,
  ],
  [
    "duplicate end",
    doc(
      "<!-- a:begin -->",
      "```bash",
      "x",
      "```",
      "<!-- a:end -->",
      "<!-- a:end -->",
    ),
    /Duplicate marker <!-- a:end -->/,
  ],
  [
    "unterminated fence",
    doc("<!-- a:begin -->", "```bash", "x", "<!-- a:end -->"),
    /unterminated ``` fence/,
  ],
  [
    "no fence",
    doc("<!-- a:begin -->", "", "<!-- a:end -->"),
    /contains no fenced block/,
  ],
  [
    "two fences",
    doc(
      "<!-- a:begin -->",
      "```bash",
      "x",
      "```",
      "```bash",
      "y",
      "```",
      "<!-- a:end -->",
    ),
    /more than one fenced block/,
  ],
  [
    "prose inside the markers",
    doc(
      "<!-- a:begin -->",
      "run this:",
      "```bash",
      "x",
      "```",
      "<!-- a:end -->",
    ),
    /text outside its fenced block/,
  ],
])("rejects %s", (_label, text, message) => {
  expect(() => extractBlock(text, "a")).toThrow(message);
});

test("rejects names that are not plain marker names", () => {
  expect(() => extractBlock("", "")).toThrow(/Invalid block name/);
  expect(() => extractBlock("", "a -->")).toThrow(/Invalid block name/);
});

test("CLI prints the block body and exits 0", () => {
  const file = tempFile(
    "ok.md",
    doc("<!-- a:begin -->", "```bash", "echo hi", "```", "<!-- a:end -->"),
  );
  const result = cli(file, "a");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("echo hi\n");
});

test("CLI exits non-zero on missing, duplicate and unterminated markers", () => {
  const missing = tempFile("missing.md", doc("```bash", "x", "```"));
  const duplicate = tempFile(
    "duplicate.md",
    doc(
      "<!-- a:begin -->",
      "<!-- a:begin -->",
      "```bash",
      "x",
      "```",
      "<!-- a:end -->",
    ),
  );
  const unterminated = tempFile(
    "unterminated.md",
    doc("<!-- a:begin -->", "```bash", "x", "```"),
  );
  for (const file of [missing, duplicate, unterminated]) {
    const result = cli(file, "a");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("manual-blocks:");
  }
  expect(cli().status).toBe(2);
});

// --- the customer manual (Gate 7, Gate 1 on a customer-style install) ---

const linux = extractBlock(readme, "g7:linux");
const windows = extractBlock(readme, "g7:windows");

test("README g7:linux is a bash block that bash can parse", () => {
  expect(linux.lang).toBe("bash");
  const file = tempFile("g7-linux.sh", linux.body);
  const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("README g7:linux pulls the published image instead of building from source", () => {
  const body = linux.body;
  expect(body).toContain(`${IMAGE}:$XIONGBAO_TAG`);
  expect(body).toMatch(
    /^XIONGBAO_TAG=\$\{XIONGBAO_TAG:-v\d+\.\d+\.\d+(-rc\.\d+)?\}$/m,
  );
  expect(body).toContain('docker pull "$XIONGBAO_IMAGE"');
  expect(body).toContain(
    `https://raw.githubusercontent.com/canquedehuiyi-cpu/xiongbaowork/\${XIONGBAO_TAG}/xiongbao/docker/delivery.env.example`,
  );
  expect(body).toContain("openssl rand -base64 32");
  for (const forbidden of [
    "xiongbao-Wake-",
    "feat/b-delivery-form",
    "docker build",
    "docker login",
    "git clone",
    "gitee.com",
    ":local",
  ]) {
    expect(body).not.toContain(forbidden);
  }
});

test("README g7:linux runs the container the way image-smoke.sh does", () => {
  const smoke = readFileSync(join(import.meta.dir, "image-smoke.sh"), "utf8");
  for (const flag of ["-p 127.0.0.1:3772:3001", ":/var/lib/postgresql"]) {
    expect(smoke).toContain(flag);
    expect(linux.body).toContain(flag);
  }
  for (const volume of [
    "-v xiongbao-local-db:/var/lib/postgresql",
    "-v xiongbao-local-workspace:/workspace",
    "-v xiongbao-local-profiles:/profiles",
  ]) {
    expect(linux.body).toContain(volume);
  }
  expect(linux.body).toContain("--env-file .env.delivery");
  expect(linux.body).toContain("deadline=$((SECONDS+60))");
  expect(linux.body).toContain("http://127.0.0.1:3772/health");
  // The image runs last on the docker run line, so a pulled image is what starts.
  expect(linux.body).toMatch(
    /-v xiongbao-local-profiles:\/profiles \\\n {2}"\$XIONGBAO_IMAGE"\n/,
  );
});

test("README g7:linux never overwrites an existing key file", () => {
  const body = linux.body;
  const guard = body.indexOf("if [ -e .env.delivery ]");
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(body.indexOf("curl --fail")).toBeGreaterThan(guard);
  expect(body.indexOf("KEY_ENCRYPTION_KEY=%s")).toBeGreaterThan(guard);
});

// --- deployment manual section 4: external PostgreSQL (Gate 7 Linux, external database job) ---

const externalMigrate = extractBlock(manual, "g7:external-migrate");
const externalRoles = extractBlock(manual, "g7:external-roles");
const cleanDeploy = readFileSync(
  join(root, ".github", "workflows", "clean-deploy.yml"),
  "utf8",
);

test("manual g7:external-migrate migrates with the released digest and the owner file only", () => {
  expect(externalMigrate.lang).toBe("bash");
  const file = tempFile("g7-external-migrate.sh", externalMigrate.body);
  const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const body = externalMigrate.body;
  expect(body).toContain(
    `XIONGBAO_IMAGE="$(jq -er '(.ghcr // .images.xiongbao).reference' container-images.json)"`,
  );
  expect(body).toContain("--env-file .env.migration");
  expect(body).toContain("scripts/migrate.ts");
  for (const forbidden of [
    ".env.delivery",
    "docker build",
    "docker login",
    "drizzle-kit",
    ":local",
  ]) {
    expect(body).not.toContain(forbidden);
  }
});

test("manual g7:external-roles locks down both runtime roles", () => {
  expect(externalRoles.lang).toBe("sql");
  const body = externalRoles.body;
  expect(body).toMatch(
    /^ALTER ROLE xiongbao_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '<[^>]+>';$/m,
  );
  expect(body).toMatch(
    /^ALTER ROLE xiongbao_role_writer WITH LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '<[^>]+>';$/m,
  );
  expect(body).toContain("'xiongbao_app', 'xiongbao_role_writer'");
});

test("clean-deploy.yml fills every placeholder of the manual's role block", () => {
  const placeholders = [...externalRoles.body.matchAll(/<[^>]+>/g)].map(
    (match) => match[0],
  );
  expect(placeholders.length).toBe(2);
  for (const placeholder of placeholders) {
    expect({
      placeholder,
      filled: cleanDeploy.includes(`s/${placeholder}/`),
    }).toEqual({ placeholder, filled: true });
  }
  for (const block of [
    "g7:external-migrate",
    "g7:external-roles",
    "g7:linux",
  ]) {
    expect(cleanDeploy).toContain(` ${block} `);
  }
});

test("manual section 4 names every database URL an external-database API needs", () => {
  // The API refuses to start without the role writer (server/src/index.ts), and the embedded
  // database is the only mode that generates it, so an external database must be told.
  const index = readFileSync(
    join(product, "server", "src", "index.ts"),
    "utf8",
  );
  expect(index).toContain("ROLE_WRITER_DATABASE_URL is required");
  const section = manual.slice(
    manual.indexOf("## 4. 外接 PostgreSQL"),
    manual.indexOf("## 5. "),
  );
  expect(section).toMatch(/^EMBEDDED_POSTGRES=off$/m);
  expect(section).toMatch(/^DATABASE_URL=postgres:\/\/xiongbao_app:/m);
  expect(section).toMatch(
    /^ROLE_WRITER_DATABASE_URL=postgres:\/\/xiongbao_role_writer:/m,
  );
});

test("README g7:windows pulls the same image and tag (manual acceptance)", () => {
  expect(windows.lang).toBe("powershell");
  expect(windows.body).toContain(`"${IMAGE}:$XiongbaoTag"`);
  expect(windows.body).toContain("docker pull $XiongbaoImage");
  const linuxTag = /XIONGBAO_TAG:-(v[^}]+)\}/.exec(linux.body)?.[1];
  expect(linuxTag).toBeTruthy();
  expect(windows.body).toContain(`else { '${linuxTag}' }`);
  for (const forbidden of [
    "xiongbao-Wake-",
    "feat/b-delivery-form",
    "docker build",
    "git clone",
    ":local",
  ]) {
    expect(windows.body).not.toContain(forbidden);
  }
});

test("README has no stale candidate or private-repository instructions", () => {
  for (const stale of [
    "xiongbao-Wake-",
    "feat/b-delivery-form",
    "xiongpinji",
    "PR #1",
    "私有仓库",
  ]) {
    expect(readme).not.toContain(stale);
  }
});

test("docker build appears only in the build-from-source appendix", () => {
  for (const [name, text] of [
    ["README.md", readme],
    ["deployment-xiongbao.md", manual],
  ]) {
    const appendix = text.indexOf("## 附录：从源码构建");
    expect({ name, appendix: appendix > 0 }).toEqual({ name, appendix: true });
    for (const needle of ["docker build", "xiongbao-digital-employee:local"]) {
      const first = text.indexOf(needle);
      expect({ name, needle, inAppendix: first > appendix }).toEqual({
        name,
        needle,
        inAppendix: true,
      });
    }
  }
});

test("deployment manual pins digests and explains how to verify them", () => {
  expect(manual).toContain(`${IMAGE}@sha256:`);
  expect(manual).toContain("container-images.json");
  expect(manual).toContain(
    "jq -er '(.ghcr // .images.xiongbao).reference' container-images.json",
  );
  expect(manual).toContain(
    `gh attestation verify "oci://$XIONGBAO_IMAGE" -R canquedehuiyi-cpu/xiongbaowork`,
  );
  expect(manual).toContain("clean-deploy.yml");
});

test("delivery.env.example documents the image override without setting it", () => {
  const example = readFileSync(
    join(product, "docker", "delivery.env.example"),
    "utf8",
  );
  expect(example).toMatch(/^# XIONGBAO_TAG=v\d+\.\d+\.\d+/m);
  expect(example).toContain(`# XIONGBAO_IMAGE=${IMAGE}:`);
  expect(example).toContain(`# XIONGBAO_IMAGE=${IMAGE}@sha256:`);
  expect(example).not.toMatch(/^XIONGBAO_IMAGE=/m);
  expect(example).not.toMatch(/^KEY_ENCRYPTION_KEY=/m);
  const compose = readFileSync(
    join(product, "docker", "compose.delivery.yml"),
    "utf8",
  );
  expect(compose).toContain("image: ${XIONGBAO_IMAGE:-");
});

function filesUnder(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test("no gitee.com in the README, deployment manuals or docker files", () => {
  const docs = join(product, "docs");
  const files = [
    join(root, "README.md"),
    ...readdirSync(docs)
      .filter((name) => /^deployment.*\.md$/.test(name))
      .map((name) => join(docs, name)),
    ...filesUnder(join(product, "docker")),
  ];
  expect(files.length).toBeGreaterThan(3);
  for (const file of files) {
    expect({
      file,
      gitee: readFileSync(file, "utf8").includes("gitee.com"),
    }).toEqual({ file, gitee: false });
  }
});

// The v0.2.17 upgrade sheet (docs/acceptance/HUMAN-STEPS.md, section 22) is what the JD Cloud server runs,
// pasted as it is. Every block must extract and parse as bash, and what the blocks spell out by hand must be
// what the code holds: the hashes of v0.2.16's two rename migrations the upgrade gate recognises, the
// baseline's and 0001's hashes the start-up leaves in the ledger, and the undo of 0001 exactly as
// scripts/rollback-after-baseline.ts reads it, with the ledger put back the way the CHANGELOG says.
// Those files never change once released (their hashes are in deployed ledgers), so this holds after
// later migrations are added too.
test("every v0.2.17 upgrade-sheet block parses and carries the code's hashes and undo SQL", async () => {
  const sheet = readFileSync(
    join(root, "docs", "acceptance", "HUMAN-STEPS.md"),
    "utf8",
  );
  const names = [
    ...new Set(
      [...sheet.matchAll(/^<!-- (v0217:[a-z0-9-]+):begin -->$/gm)].map(
        (match) => match[1],
      ),
    ),
  ];
  expect(names.length).toBeGreaterThanOrEqual(12);
  const blocks = {};
  for (const name of names) {
    const { lang, body } = extractBlock(sheet, name);
    expect({ name, lang }).toEqual({ name, lang: "bash" });
    const parsed = spawnSync("bash", ["-n"], { input: body, encoding: "utf8" });
    expect({ name, status: parsed.status, stderr: parsed.stderr }).toEqual({
      name,
      status: 0,
      stderr: "",
    });
    blocks[name] = body;
  }

  const drizzle = join(product, "server", "drizzle");
  const { RENAME_MIGRATIONS } = await import(
    "../../server/src/db/upgrade-gate.ts"
  );
  const { readMigrationFolder } = await import(
    "../../server/src/db/migration-reach.ts"
  );
  const { rollbackBlock } = await import(
    "../../server/scripts/rollback-after-baseline.ts"
  );
  expect(RENAME_MIGRATIONS.length).toBe(2);
  for (const [, hash] of RENAME_MIGRATIONS)
    expect(blocks["v0217:check"]).toContain(`'${hash}'`);

  const [baseline, corrections] = await readMigrationFolder(drizzle);
  expect([baseline?.tag, corrections?.tag]).toEqual([
    "0000_baseline",
    "0001_memory_corrections",
  ]);
  expect(blocks["v0217:check"]).toContain(`hash = '${baseline.hash}'`);
  expect(sheet).toContain(
    `\`ledger=2 ${baseline.hash.slice(0, 12)},${corrections.hash.slice(0, 12)}\``,
  );

  // One transaction: 0001's own undo, as rollback-after-baseline.ts reads it from the file, then the
  // ledger put back from the rows the adoption kept.
  const statements = rollbackBlock(
    corrections.tag,
    readFileSync(join(drizzle, `${corrections.tag}.sql`), "utf8"),
  );
  expect(statements).toHaveLength(3);
  const transaction =
    /owner_sql <<'SQL'\n(BEGIN;\n[\s\S]*?\nCOMMIT;)\nSQL/.exec(
      blocks["v0217:rollback-b"],
    )?.[1];
  expect(typeof transaction).toBe("string");
  const lines = String(transaction)
    .split("\n")
    .filter((line) => !line.startsWith("--"));
  expect(lines).toEqual([
    "BEGIN;",
    "SET LOCAL lock_timeout = '10s';",
    ...statements,
    "DELETE FROM drizzle.__drizzle_migrations;",
    "INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) SELECT id, hash, created_at FROM drizzle.__drizzle_migrations_before_baseline;",
    "COMMIT;",
  ]);
  const restore =
    "BEGIN; DELETE FROM drizzle.__drizzle_migrations; INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) SELECT id, hash, created_at FROM drizzle.__drizzle_migrations_before_baseline; COMMIT;";
  expect(readFileSync(join(product, "CHANGELOG.md"), "utf8")).toContain(
    restore,
  );
});
