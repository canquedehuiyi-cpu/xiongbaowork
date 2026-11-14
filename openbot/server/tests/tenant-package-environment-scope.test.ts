// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every `${...}` in this file is a literal fixture — the contract under test is that these bytes survive unexpanded, so a real template would defeat the test.

import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  expandPackageDocument,
  loadTenantPackage,
} from "../src/tenant-package";

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

/**
 * A shipped package with one more skill, whose body holds a placeholder nobody sets.
 *
 * APPENDED, not written over: the package's own `agents.yaml` names the skills it expects, so a
 * `skills.yaml` holding nothing but the probe is refused for a broken reference and the test would
 * pass without ever reaching the question it asks.
 */
async function packageWithPlaceholderBody(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "expand-scope-"));
  temporaryDirectories.push(directory);
  // `cp` with an existing destination copies *into* it, so name the package directory explicitly —
  // otherwise the package lands one level too deep and the loader sees no brand.yaml.
  await cp(join(examples, "personal"), join(directory, "package"), {
    recursive: true,
  });
  const skillsPath = join(directory, "package", "skills.yaml");
  const shipped = await readFile(skillsPath, "utf8");
  await writeFile(
    skillsPath,
    `${shipped.trimEnd()}\n${[
      "  - slug: scope-probe",
      "    title: Scope probe",
      // `title` and `summary` are what validation refuses a package for lacking, and this fixture has
      // to reach validation: the point of the test is a body that loads, so a package refused for an
      // unrelated reason would pass it by accident.
      "    summary: A body that must survive loading byte for byte",
      "    instructions: |-",
      "      echo the marker below verbatim",
      '      run "${NOT_SET_ANYWHERE}" here',
      "    tools: []",
      "",
    ].join("\n")}`,
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

  test("every body in the shipped package loads exactly as the file wrote it", async () => {
    /*
     * The two assertions above pin the bodies that were actually rewritten; this one keeps the next
     * one from arriving unnoticed. A whitelist can be widened by a later edit to this list as easily
     * as it was narrowed by this one, and the symptom would be a body that still *looks* right — the
     * difference only shows on a machine whose environment happens to set the name.
     *
     * Compared against the file parsed here, not against what the loader returns: two reads of the
     * same file agree, so any difference between them is the expander's doing.
     */
    const authored = parse(
      await readFile(join(examples, "xiongbao", "skills.yaml"), "utf8"),
    ) as { skills: { slug: string; instructions: string }[] };
    const loaded = await loadTenantPackage(join(examples, "xiongbao"));
    const bySlug = new Map(
      loaded.skills.map((skill) => [skill.slug, skill.instructions]),
    );
    expect(authored.skills.length).toBeGreaterThan(100);
    // Names rather than bodies: a failure has to be readable, and these bodies run to tens of
    // thousands of characters each.
    expect(
      authored.skills
        .filter((skill) => bySlug.get(skill.slug) !== skill.instructions)
        .map((skill) => skill.slug),
    ).toEqual([]);
  });

  test("the checksum covers the files, so another environment is not another package", async () => {
    /*
     * The checksum decides whether the deployment re-synchronises, so hashing the EXPANDED text
     * would make "this machine's address changed" look like "somebody edited the package": every
     * boot against a differently-configured stack would seed and revoke again for no reason.
     *
     * Hashing the file as written is also what makes the two facts in this describe independent —
     * a body that kept its bytes and a checksum that moved would still be one package.
     */
    const previous = process.env.PICKED_HARNESS_URL;
    try {
      process.env.PICKED_HARNESS_URL = "https://one.example.test/ag-ui";
      const one = await loadTenantPackage(join(examples, "personal"));
      process.env.PICKED_HARNESS_URL = "https://two.example.test/ag-ui";
      const two = await loadTenantPackage(join(examples, "personal"));
      expect(two.checksum).toBe(one.checksum);
    } finally {
      if (previous === undefined) {
        delete process.env.PICKED_HARNESS_URL;
      } else {
        process.env.PICKED_HARNESS_URL = previous;
      }
    }
  });
});

/**
 * The list itself, field by field.
 *
 * A whitelist's failure mode is silence: a field nobody added keeps its `${...}` and the deployment
 * ships a Bot pointed at the literal text of an address. Loading a real package cannot show that —
 * it only proves the fields that package happens to use — so each field on the list, and one field
 * off it, is asserted here directly.
 */
describe("which fields take a value from the environment", () => {
  const environment = {
    DEPLOYED_URL: "https://deployed.example.test/ag-ui",
    DEPLOYED_NAME: "The Deployed One",
    DEPLOYED_AGENT_ID: "roster-7",
  };

  const expanded = (agent: Record<string, unknown>) =>
    (
      expandPackageDocument(
        { agents: [{ id: "ops", ...agent }] },
        "agents.yaml",
        environment,
      ).agents as Record<string, unknown>[]
    )[0];

  test("every field on the list follows the environment", () => {
    const agent = expanded({
      type: "${DEPLOYED_KIND:-remote-mastra}",
      name: "${DEPLOYED_NAME}",
      title: "Powered by ${DEPLOYED_NAME}",
      endpoint: "${DEPLOYED_URL}",
      remote_agent_id: "${DEPLOYED_AGENT_ID}",
    });
    // `DEPLOYED_KIND` is deliberately unset: the point is that a default on the list is taken, not
    // that a name has to exist.
    expect(agent).toMatchObject({
      type: "remote-mastra",
      name: "The Deployed One",
      title: "Powered by The Deployed One",
      endpoint: "https://deployed.example.test/ag-ui",
      remote_agent_id: "roster-7",
    });
  });

  test("the prose beside them keeps its bytes", () => {
    const agent = expanded({
      role_description: "answers at ${DEPLOYED_URL}",
      system_prompt: "quote ${DEPLOYED_URL} exactly",
    });
    // These two are what a model is asked to follow. Substituting an address into them would make
    // the same package instruct two deployments differently, which is the bug this scope exists for.
    expect(agent.role_description).toBe("answers at ${DEPLOYED_URL}");
    expect(agent.system_prompt).toBe("quote ${DEPLOYED_URL} exactly");
  });

  test("a coworker in its own file is expanded the same way, in either shape", () => {
    const listed = expandPackageDocument(
      { agents: [{ id: "ops", endpoint: "${DEPLOYED_URL}" }] },
      "agents/dropped-in.yaml",
      environment,
    );
    expect((listed.agents as Record<string, unknown>[])[0].endpoint).toBe(
      "https://deployed.example.test/ag-ui",
    );

    // The other legal shape: the whole file is the one coworker.
    const alone = expandPackageDocument(
      { id: "ops", endpoint: "${DEPLOYED_URL}" },
      "agents/dropped-in.yaml",
      environment,
    );
    expect(alone.endpoint).toBe("https://deployed.example.test/ag-ui");
  });

  test("a skill body is text, not a template, even with a name that is set", () => {
    const document = expandPackageDocument(
      {
        skills: [
          {
            slug: "teaching-shell",
            instructions: 'blob="raw-${DEPLOYED_URL}.txt"',
          },
        ],
      },
      "skills.yaml",
      environment,
    );
    expect((document.skills as Record<string, unknown>[])[0].instructions).toBe(
      'blob="raw-${DEPLOYED_URL}.txt"',
    );
  });

  test("a connector takes its address and the hostname restated from it", () => {
    const document = expandPackageDocument(
      {
        connectors: [
          {
            id: "vault",
            title: "keeps ${DEPLOYED_NAME}",
            url: "${DEPLOYED_URL}/mcp",
            host: "${DEPLOYED_HOST:-deployed.example.test}",
          },
        ],
      },
      "connectors.yaml",
      environment,
    );
    // Both, because validation refuses a host that is not exactly the URL's: expanding one only
    // would refuse the package.
    expect((document.connectors as Record<string, unknown>[])[0]).toMatchObject(
      {
        title: "keeps ${DEPLOYED_NAME}",
        url: "https://deployed.example.test/ag-ui/mcp",
        host: "deployed.example.test",
      },
    );
  });

  test("the brand keeps its copy and expands only where people are sent for help", () => {
    const document = expandPackageDocument(
      {
        tenant: {
          id: "mine",
          product_name: "Mine, not ${DEPLOYED_NAME}",
          support_url: "${DEPLOYED_URL}/help",
        },
      },
      "brand.yaml",
      environment,
    );
    expect(document.tenant).toMatchObject({
      product_name: "Mine, not ${DEPLOYED_NAME}",
      support_url: "https://deployed.example.test/ag-ui/help",
    });
  });

  test("a placeholder in a field nobody whitelisted cannot refuse the package", () => {
    // The old scope threw here — the whole package failed to load because some prose happened to
    // look like a template. Prose is not required to know that an expander exists.
    const document = expandPackageDocument(
      { sources: [{ type: "google-drive", roots: ["${NOT_SET_ANYWHERE}"] }] },
      "knowledge.yaml",
      {},
    );
    expect((document.sources as Record<string, unknown>[])[0].roots).toEqual([
      "${NOT_SET_ANYWHERE}",
    ]);
  });

  test("an unset name on the list is still refused, naming the file", () => {
    // The whitelist narrows WHAT is a template; a field that is one still cannot be left empty,
    // because substituting nothing points a Bot at an address nobody meant.
    expect(() =>
      expandPackageDocument(
        { agents: [{ id: "ops", endpoint: "${MISSING_ADDRESS}" }] },
        "agents.yaml",
        {},
      ),
    ).toThrow(/agents\.yaml refers to \$\{MISSING_ADDRESS\}/);
  });
});
