import { describe, expect, test } from "bun:test";
import {
  BRAND,
  codeLines,
  linesOf,
  masked,
  scannedFiles,
} from "../../scripts/brand/guard/scan";

const ALLOW = [
  'optional(environment, "OPENBOT_PUBLIC_URL")',
  "env.OPENBOT_RLS_ENFORCE",
  "const OPENBOT_TOOL_LIMIT = 1;",
  '"OPENBOT_APPROVAL_EXACT_AEAD_V1"',
  "OPENBOT_POOL_MAX",
  "process.env.COPILOTKIT_TELEMETRY_DISABLED",
];

const REPORT = [
  '"Set OPENBOT_PUBLIC_URL to the address"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the line under test is source text
  '`OPENBOT_EDITION is "${value}"`',
  'code: "OPENBOT_MODEL_AUTH_REQUIRED",',
  '"XIONGBAO_PUBLIC_URL（旧名 OPENBOT_PUBLIC_URL 仍可用）"',
];

describe("OPENBOT_ rules split by use", () => {
  for (const line of ALLOW)
    test(`allows ${line}`, () => {
      expect(BRAND.test(masked(line))).toBe(false);
    });
  for (const line of REPORT)
    test(`reports ${line}`, () => {
      expect(BRAND.test(masked(line))).toBe(true);
    });

  test("# starts a comment in a Dockerfile, but only there", () => {
    const comment = "# OpenBot, whole, in one container.";
    expect(linesOf("Dockerfile", comment)).toEqual([]);
    expect(linesOf("docker/s6/scripts/x.sh", comment)).toEqual([]);
    expect(linesOf("docker/s6/s6-rc.d/api/run", comment)).toEqual([]);
    expect(linesOf("docker/compose.delivery.yml", comment)).toEqual([]);
    expect(linesOf("app/src/a.css", comment).length).toBe(1);
    expect(linesOf("Dockerfile", "ENV OPENBOT_IN_CONTAINER=true").length).toBe(
      1,
    );
    expect(codeLines(comment).length).toBe(1);
  });

  test("the new scopes are scanned", () => {
    const files = scannedFiles();
    for (const path of [
      "Dockerfile",
      "agent-computer/src/index.ts",
      "docker/xiongbao-apt",
      "extension/scripts/build.ts",
    ])
      expect(files).toContain(path);
    expect(files.some((f) => f.startsWith("docker/tests/"))).toBe(false);
    expect(files.some((f) => f.startsWith("charts/"))).toBe(false);
  });
});
