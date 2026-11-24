import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("run-review.sh", import.meta.url).pathname;
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "ocr-run-"));
  made.push(dir);
  return dir;
}

/** An `ocr` that records its arguments and the key it was configured with, and writes a small report. */
function stubOcr(
  dir: string,
  options: {
    leakKey?: boolean;
    failVersion?: boolean;
    failConfig?: boolean;
  } = {},
) {
  const bin = join(dir, "ocr-stub");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$@" >> "${dir}/calls.txt"
echo "telemetry=\${OCR_ENABLE_TELEMETRY-unset}" >> "${dir}/calls.txt"
case "$1" in
  --version) ${options.failVersion ? "exit 3" : 'echo "open-code-review v1.14.2 (stub)"'};;
  config) ${options.failConfig ? "exit 4" : ":"};;
  review)
    out=""
    while [ $# -gt 0 ]; do [ "$1" = "--output" ] && out="$2"; shift; done
    echo '{"comments":[]}'${options.leakKey ? ` " leaked $OCR_API_KEY"` : ""} > "$out"
    ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function run(env: Record<string, string>, out: string) {
  const result = Bun.spawnSync(["bash", script], {
    env: { PATH: process.env.PATH ?? "", OCR_OUT_DIR: out, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, text: result.stdout.toString() };
}

test("without a model key the run is skipped, says why, and succeeds", () => {
  const dir = scratch();
  const out = join(dir, "out");
  const { code, text } = run({ OCR_BASE: "main", OCR_HEAD: "topic" }, out);
  expect(code).toBe(0);
  expect(text).toContain("ocr-review skipped");
  const skipped = JSON.parse(readFileSync(join(out, "skipped.json"), "utf8"));
  expect(skipped.skipped).toBe(true);
  expect(skipped.reason).toContain("OCR_API_KEY");
  expect(skipped.ocr_version).toBe("1.14.2");
  expect(existsSync(join(out, "ocr-report.json"))).toBe(false);
});

test("an empty key is the same as a missing one", () => {
  const dir = scratch();
  const out = join(dir, "out");
  const { code } = run({ OCR_BASE: "main", OCR_API_KEY: "" }, out);
  expect(code).toBe(0);
  expect(existsSync(join(out, "skipped.json"))).toBe(true);
});

test("without a base the run is skipped", () => {
  const dir = scratch();
  const out = join(dir, "out");
  const { code } = run({ OCR_API_KEY: "k" }, out);
  expect(code).toBe(0);
  expect(readFileSync(join(out, "SKIPPED.txt"), "utf8")).toContain("OCR_BASE");
});

test("a run with a key reviews the range with the rule file, the budget and a json report", () => {
  const dir = scratch();
  const out = join(dir, "out");
  const { code } = run(
    {
      OCR_BASE: "origin/main",
      OCR_HEAD: "topic",
      OCR_API_KEY: "sk-test-secret-123",
      OCR_PROVIDER: "deepseek",
      OCR_BIN: stubOcr(dir),
    },
    out,
  );
  expect(code).toBe(0);
  const calls = readFileSync(join(dir, "calls.txt"), "utf8");
  expect(calls).toContain("config set provider deepseek");
  expect(calls).toContain("config set model deepseek-v4-flash");
  expect(calls).toContain("--from origin/main --to topic");
  expect(calls).toContain("rules/xiongbao-review.rule.json");
  expect(calls).toContain("--max-tokens-budget 1500000");
  expect(calls).toContain("--format json");
  expect(calls).toContain("**/tests/**");
  expect(existsSync(join(out, "ocr-report.json"))).toBe(true);
  expect(readFileSync(join(out, "summary.md"), "utf8")).toContain(
    "advice only",
  );
});

test("the model key does not stay in anything the artifact carries", () => {
  const dir = scratch();
  const out = join(dir, "out");
  const key = "sk-test-secret-123";
  run(
    {
      OCR_BASE: "main",
      OCR_API_KEY: key,
      OCR_PROVIDER: "deepseek",
      OCR_BIN: stubOcr(dir, { leakKey: true }),
    },
    out,
  );
  for (const name of readdirSync(out))
    expect(readFileSync(join(out, name), "utf8")).not.toContain(key);
  expect(existsSync(join(out, "ocr-report.json"))).toBe(false);
  expect(readFileSync(join(out, "summary.md"), "utf8")).toContain(
    "removed ocr-report.json",
  );
});

test("OCR_INCLUDE_TESTS=1 stops excluding test files", () => {
  const dir = scratch();
  const out = join(dir, "out");
  run(
    {
      OCR_BASE: "main",
      OCR_API_KEY: "k",
      OCR_PROVIDER: "deepseek",
      OCR_BIN: stubOcr(dir),
      OCR_INCLUDE_TESTS: "1",
    },
    out,
  );
  expect(readFileSync(join(dir, "calls.txt"), "utf8")).not.toContain(
    "**/tests/**",
  );
});

test("the pinned version is a number, never latest", () => {
  const text = readFileSync(script, "utf8");
  expect(text).toMatch(/^OCR_VERSION="\d+\.\d+\.\d+"$/m);
  expect(text).not.toContain("@latest");
});

test("without a provider the run is skipped and says which variable is missing, nothing is configured", () => {
  const dir = scratch();
  const out = join(dir, "out");
  const { code } = run(
    { OCR_BASE: "main", OCR_API_KEY: "k", OCR_BIN: stubOcr(dir) },
    out,
  );
  expect(code).toBe(0);
  expect(readFileSync(join(out, "SKIPPED.txt"), "utf8")).toContain(
    "OCR_PROVIDER",
  );
  expect(existsSync(join(dir, "calls.txt"))).toBe(false);
  expect(existsSync(join(out, "ocr-report.json"))).toBe(false);
});

test("a provider name that is not a plain word is refused before it reaches a config key", () => {
  const dir = scratch();
  const out = join(dir, "out");
  const { code } = run(
    {
      OCR_BASE: "main",
      OCR_API_KEY: "k",
      OCR_PROVIDER: "x api_key=1 $(id)",
      OCR_BIN: stubOcr(dir),
    },
    out,
  );
  expect(code).toBe(0);
  expect(existsSync(join(out, "SKIPPED.txt"))).toBe(true);
  expect(existsSync(join(dir, "calls.txt"))).toBe(false);
});

test("telemetry is switched off explicitly, even when the caller's environment has it on", () => {
  const dir = scratch();
  const out = join(dir, "out");
  run(
    {
      OCR_BASE: "main",
      OCR_API_KEY: "k",
      OCR_PROVIDER: "deepseek",
      OCR_ENABLE_TELEMETRY: "1",
      OCR_BIN: stubOcr(dir),
    },
    out,
  );
  const calls = readFileSync(join(dir, "calls.txt"), "utf8");
  expect(calls).toContain("telemetry=0");
  expect(calls).not.toContain("telemetry=1");
  expect(calls).not.toContain("telemetry=unset");
});

test("an ocr that cannot report its version, or refuses the config, is a skipped run and exits 0", () => {
  for (const options of [{ failVersion: true }, { failConfig: true }]) {
    const dir = scratch();
    const out = join(dir, "out");
    const { code } = run(
      {
        OCR_BASE: "main",
        OCR_API_KEY: "k",
        OCR_PROVIDER: "deepseek",
        OCR_BIN: stubOcr(dir, options),
      },
      out,
    );
    expect(code).toBe(0);
    expect(existsSync(join(out, "SKIPPED.txt"))).toBe(true);
    expect(existsSync(join(out, "ocr-report.json"))).toBe(false);
  }
});

test("a config failure leaves no key in what the artifact carries", () => {
  const dir = scratch();
  const out = join(dir, "out");
  run(
    {
      OCR_BASE: "main",
      OCR_API_KEY: "sk-test-secret-123",
      OCR_PROVIDER: "deepseek",
      OCR_BIN: stubOcr(dir, { failConfig: true }),
    },
    out,
  );
  for (const name of readdirSync(out))
    expect(readFileSync(join(out, name), "utf8")).not.toContain(
      "sk-test-secret-123",
    );
});

test("npm install runs without the model key in its environment", () => {
  const dir = scratch();
  const out = join(dir, "out");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = stubOcr(dir);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash
echo "npm-sees-key=\${OCR_API_KEY-unset}" >> "${dir}/npm.txt"
while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && prefix="$2"; shift; done
mkdir -p "$prefix/node_modules/.bin"
cp "${stub}" "$prefix/node_modules/.bin/ocr"
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  const { code } = run(
    {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      OCR_BASE: "main",
      OCR_API_KEY: "sk-test-secret-123",
      OCR_PROVIDER: "deepseek",
    },
    out,
  );
  expect(code).toBe(0);
  expect(readFileSync(join(dir, "npm.txt"), "utf8")).toBe(
    "npm-sees-key=unset\n",
  );
  // The key is still given to ocr itself.
  expect(readFileSync(join(dir, "calls.txt"), "utf8")).toContain(
    "providers.deepseek.api_key sk-test-secret-123",
  );
});
