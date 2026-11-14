// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every `${...}` in this file is a literal fixture — the contract under test is that these bytes survive unexpanded, so a real template would defeat the test.

import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenantPackage } from "../src/tenant-package";


/**
 * The scope of `${NAME}` expansion.
 *
 * A package file is two kinds of text at once: machine fields whose value belongs to the deployment
 * (a Bot's `endpoint`, the harness it picked) and prose written for a person and for the model
 * (`skills[].instructions`, brand copy, knowledge bodies). Expansion is a service to the first kind
 * and an attack on the second: the same package renders different instructions on two machines whose
 * environment differs, and a placeholder with no default refuses the whole package.
 *
 * Both halves of that were observed on the shipped package before this contract existed:
 *
 *   `"$P/${lbl:-}_raw.txt"`                         → `"$P/_raw.txt"`      (the two runs now write the same file)
 *   `threshold=${…:-20(内置默认)}`                   → `threshold=50`       (this machine happens to set it)
 *
 * So these tests pin the boundary rather than the mechanism: prose keeps its bytes, whitelisted
 * fields still follow the environment.
 */

const examples = fileURLToPath(new URL("../../examples/", import.meta.url));
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

/** A package with exactly one skill, whose body holds a placeholder nobody sets. */
async function packageWithPlaceholderBody(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "expand-scope-"));
  temporaryDirectories.push(directory);
  // `cp` with an existing destination copies *into* it, so name the package directory explicitly —
  // otherwise the package lands one level too deep and the loader sees no brand.yaml.
  await cp(join(examples, "personal"), join(directory, "package"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "package", "skills.yaml"),
    [
      "skills:",
      "  - slug: scope-probe",
      "    instructions: |-",
      "      echo the marker below verbatim",
      '      run "${NOT_SET_ANYWHERE}" here',
      "",
    ].join("\n"),
    "utf8",
  );
  return join(directory, "package");
}

describe("the scope of environment expansion", () => {
  test("a placeholder in a skill body does not refuse the package", async () => {
    const directory = await packageWithPlaceholderBody();
    const loaded = await loadTenantPackage(directory);
    const skill = loaded.skills.find(
      (candidate) => candidate.slug === "scope-probe",
    );
    expect((skill?.instructions ?? "").includes("${NOT_SET_ANYWHERE}")).toBe(
      true,
    );
  });

  test("the shipped package keeps the two bodies that used to be rewritten", async () => {
    const loaded = await loadTenantPackage(join(examples, "xiongbao"));
    const bySlug = new Map(
      loaded.skills.map((skill) => [skill.slug, skill.instructions]),
    );

    const baseline = bySlug.get("baseline-regression-triage") ?? "";
    // 抹掉 `${lbl:-}` 之后，head 与 base 两轮跑会写进同一个 `$P/_raw.txt`，第二次覆盖第一次。
    // 用 includes + toBe(true) 而不是 toContain：失败时只打印一个布尔，
    // 否则断言把整篇十几万字的正文喷进 CI 日志。
    expect(baseline.includes('"$P/${lbl:-}_raw.txt"')).toBe(true);

    const guard = bySlug.get("workbuddy-safe-delete-guard") ?? "";
    // 这里的默认值是写给人看的说明；跟随本机环境替换，等于让同一份包在不同机器上读出不同阈值。
    expect(
      guard.includes(
        "threshold=${CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD:-20(内置默认)}",
      ),
    ).toBe(true);
  });

  test("whitelisted agent fields still follow the environment", async () => {
    // `endpoint: ${PICKED_HARNESS_URL:-}` 展开成空串时这个远程同事会被丢弃（设计如此），
    // 所以先给它一个地址，否则这里测的就不是展开，而是「空 endpoint 被丢掉」。
    const previous = process.env.PICKED_HARNESS_URL;
    process.env.PICKED_HARNESS_URL = "https://bots.example.test/ag-ui";
    try {
      const loaded = await loadTenantPackage(join(examples, "personal"));
      const picked = loaded.agents.find(
        (agent) => agent.id === "picked-harness",
      );
      // `${PICKED_HARNESS_NAME:-Your Bot}` 落在白名单字段上，未设时取其默认值。
      expect(picked?.name).toBe("Your Bot");
    } finally {
      if (previous === undefined) {
        delete process.env.PICKED_HARNESS_URL;
      } else {
        process.env.PICKED_HARNESS_URL = previous;
      }
    }
  });
});
