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
const openbot = join(import.meta.dir, "..", "..");
const root = join(openbot, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const manual = readFileSync(
  join(openbot, "docs", "deployment-qoderwake.md"),
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
  expect(body).toContain(`${IMAGE}:$OPENBOT_TAG`);
  expect(body).toMatch(
    /^OPENBOT_TAG=\$\{OPENBOT_TAG:-v\d+\.\d+\.\d+(-rc\.\d+)?\}$/m,
  );
  expect(body).toContain('docker pull "$OPENBOT_IMAGE"');
  expect(body).toContain(
    "https://raw.githubusercontent.com/canquedehuiyi-cpu/xiongbaowork/$OPENBOT_TAG/openbot/docker/delivery.env.example",
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
    /-v xiongbao-local-profiles:\/profiles \\\n {2}"\$OPENBOT_IMAGE"\n/,
  );
});

test("README g7:linux never overwrites an existing key file", () => {
  const body = linux.body;
  const guard = body.indexOf("if [ -e .env.delivery ]");
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(body.indexOf("curl --fail")).toBeGreaterThan(guard);
  expect(body.indexOf("KEY_ENCRYPTION_KEY=%s")).toBeGreaterThan(guard);
});

test("README g7:windows pulls the same image and tag (manual acceptance)", () => {
  expect(windows.lang).toBe("powershell");
  expect(windows.body).toContain(`"${IMAGE}:$OpenbotTag"`);
  expect(windows.body).toContain("docker pull $OpenbotImage");
  const linuxTag = /OPENBOT_TAG:-(v[^}]+)\}/.exec(linux.body)?.[1];
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
    ["deployment-qoderwake.md", manual],
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
    "jq -r .images.openbot.reference container-images.json",
  );
  expect(manual).toContain(
    `gh attestation verify "oci://$OPENBOT_IMAGE" -R canquedehuiyi-cpu/xiongbaowork`,
  );
  expect(manual).toContain("clean-deploy.yml");
});

test("delivery.env.example documents the image override without setting it", () => {
  const example = readFileSync(
    join(openbot, "docker", "delivery.env.example"),
    "utf8",
  );
  expect(example).toMatch(/^# OPENBOT_TAG=v\d+\.\d+\.\d+/m);
  expect(example).toContain(`# OPENBOT_IMAGE=${IMAGE}:`);
  expect(example).toContain(`# OPENBOT_IMAGE=${IMAGE}@sha256:`);
  expect(example).not.toMatch(/^OPENBOT_IMAGE=/m);
  expect(example).not.toMatch(/^KEY_ENCRYPTION_KEY=/m);
  const compose = readFileSync(
    join(openbot, "docker", "compose.delivery.yml"),
    "utf8",
  );
  expect(compose).toContain("image: ${OPENBOT_IMAGE:-");
});

function filesUnder(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test("no gitee.com in the README, deployment manuals or docker files", () => {
  const docs = join(openbot, "docs");
  const files = [
    join(root, "README.md"),
    ...readdirSync(docs)
      .filter((name) => /^deployment.*\.md$/.test(name))
      .map((name) => join(docs, name)),
    ...filesUnder(join(openbot, "docker")),
  ];
  expect(files.length).toBeGreaterThan(3);
  for (const file of files) {
    expect({
      file,
      gitee: readFileSync(file, "utf8").includes("gitee.com"),
    }).toEqual({ file, gitee: false });
  }
});
