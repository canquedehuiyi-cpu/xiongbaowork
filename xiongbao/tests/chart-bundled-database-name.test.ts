import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

/**
 * A release installed before v0.2.17 with the bundled database keeps its database name.
 *
 * `postgresql.auth.database` moved to `xiongbao` in v0.2.17, and PostgreSQL never renames the database
 * an existing volume was created with, so an upgrade with the new default would point the migrations
 * Job and the API at a database that does not exist. `templates/validation.yaml` refuses that upgrade,
 * naming the name the database's StatefulSet was created with, and the README says how to read it where
 * the chart cannot (`helm template`, Argo CD).
 *
 * The refusal reads the cluster with `lookup`, which `helm template` cannot do, so its shape is asserted
 * on the template's text; with helm on PATH, an upgrade render without a cluster is shown to go through.
 */
const chart = join(import.meta.dir, "../charts/xiongbao");
const validation = readFileSync(
  join(chart, "templates/validation.yaml"),
  "utf8",
);
const values = readFileSync(join(chart, "values.yaml"), "utf8");
const readme = readFileSync(join(chart, "README.md"), "utf8");
const helm = Bun.which("helm") !== null;

/** The validation block about the bundled database's name, from its `if` to the matching `end`s. */
function nameCheck(): string {
  const start = validation.indexOf(
    "{{- if and .Values.postgresql.enabled .Release.IsUpgrade }}",
  );
  expect(start).toBeGreaterThan(-1);
  return validation.slice(start);
}

describe("the bundled database's name on an upgrade", () => {
  test("new installs default to xiongbao, and the value is documented as read once", () => {
    expect(values).toMatch(/\n {4}database: xiongbao\n/);
    expect(values).toContain("must keep that name here on every upgrade");
  });

  test("an upgrade is refused when the value differs from the name the database was created with", () => {
    const check = nameCheck();
    // Read from the subchart's StatefulSet, the env the database was initialized from.
    expect(check).toContain(
      'lookup "apps/v1" "StatefulSet" .Release.Namespace (printf "%s-postgresql" .Release.Name)',
    );
    expect(check).toContain('(list "POSTGRES_DATABASE" "POSTGRES_DB")');
    // Only when the cluster answered and the names differ; the message names the value and the name.
    expect(check).toContain(
      "{{- if and $created (ne $created (toString .Values.postgresql.auth.database)) }}",
    );
    expect(check).toContain("set postgresql.auth.database=%s");
    // Upgrades only, the bundled database only: an install, or an external database, is not asked.
    expect(
      check.startsWith(
        "{{- if and .Values.postgresql.enabled .Release.IsUpgrade }}",
      ),
    ).toBe(true);
  });

  test("the README says how to read the name where the chart cannot look", () => {
    expect(readme).toContain(
      "### Coming from a release before v0.2.17 with the bundled database: keep its name",
    );
    expect(readme).toContain("get statefulset <release>-postgresql");
    expect(readme).toContain('env[?(@.name=="POSTGRES_DATABASE")].value');
    expect(readme).toContain("--set postgresql.auth.database=<that name>");
  });

  test.skipIf(!helm)(
    "an upgrade render without a cluster goes through (lookup sees nothing)",
    () => {
      const result = Bun.spawnSync(
        [
          "helm",
          "template",
          "xiongbao",
          chart,
          "--is-upgrade",
          "--namespace",
          "xiongbao",
          "--values",
          join(chart, "ci/self-hosted-values.yaml"),
          "--set-string",
          `secrets.keyEncryptionKey=${randomBytes(32).toString("base64")}`,
          "--api-versions",
          "agents.x-k8s.io/v1beta1/Sandbox",
          "--api-versions",
          "extensions.agents.x-k8s.io/v1beta1/SandboxTemplate",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(new TextDecoder().decode(result.stderr)).not.toContain(
        "The bundled database of this release",
      );
      expect(result.exitCode).toBe(0);
      const docs = parseAllDocuments(new TextDecoder().decode(result.stdout))
        .map((document) => document.toJSON() as { kind?: string } | null)
        .filter(Boolean);
      expect(docs.length).toBeGreaterThan(0);
    },
  );
});
