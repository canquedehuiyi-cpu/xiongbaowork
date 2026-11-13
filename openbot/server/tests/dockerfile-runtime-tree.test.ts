import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dockerfile = readFileSync(
  join(import.meta.dir, "../../Dockerfile"),
  "utf8",
);
// Only the final stage ships: what a builder stage copies says nothing about the image.
const runtime = dockerfile.split(/^FROM\s.*$/m).pop() ?? "";
// Whitespace and flags (--chown, --link) say nothing about WHAT is copied: compare source and target only.
const copies = runtime
  .split("\n")
  .filter((line) => /^COPY\s/.test(line))
  .map((line) =>
    line
      .trim()
      .split(/\s+/)
      .filter(
        (word, index) =>
          index === 0 || !word.startsWith("--") || word.startsWith("--from="),
      )
      .join(" "),
  );

describe("the runtime image's tree", () => {
  test("the runtime stage no longer copies the whole server directory from the build context", () => {
    expect(copies).not.toContain("COPY server server");
    expect(copies).not.toContain("COPY shared shared");
    expect(copies).not.toContain("COPY toolkit toolkit");
    expect(copies).not.toContain("COPY examples examples");
    expect(
      copies.some((line) =>
        /^COPY --from=runtime-src\s.*\sserver\/?$/.test(line),
      ),
    ).toBe(true);
  });

  test("a runtime-src stage deletes the tests, docs and non-tenant examples", () => {
    const stage =
      dockerfile.split(/^FROM\s/m).find((s) => s.includes("AS runtime-src")) ??
      "";
    expect(stage).not.toBe("");
    for (const gone of [
      "server/tests",
      "server/docs",
      "server/tsconfig.tests.json",
      "toolkit/tests",
    ])
      expect(stage, gone).toContain(gone);
    expect(stage).toContain("-delete");
    // Unit tests beside the shared and browser sources go by name, not by directory.
    expect(stage).toMatch(
      /find shared agent-computer\/src -type f -name '\*\.test\.ts' -delete/,
    );
    // An examples directory survives exactly when it is a tenant package, i.e. carries a brand.yaml.
    expect(stage).toMatch(
      /find examples -mindepth 1 -maxdepth 1 -type d ! -exec test -f '\{\}\/brand\.yaml'/,
    );
  });

  test("the build identity is XIONGBAO_BUILD_*, with no OPENBOT_BUILD_ build argument left", () => {
    expect(dockerfile).toContain("ARG XIONGBAO_BUILD_VERSION");
    expect(dockerfile).not.toContain("ARG OPENBOT_BUILD_");
  });

  test("an unset build argument cannot erase a run-time OPENBOT_BUILD_* (ENV keeps the name the server reads)", () => {
    // An unset ARG still becomes an EMPTY variable. Baked under its XIONGBAO_ name, the alias layer
    // would copy that empty value over an OPENBOT_BUILD_* the deployment supplies at run time.
    expect(dockerfile).not.toMatch(/^ENV XIONGBAO_BUILD_/m);
    for (const part of [
      "VERSION",
      "COMMIT",
      "DISTRIBUTION_ID",
      "REPOSITORY",
      "CHANNEL",
    ])
      expect(dockerfile, part).toContain(
        `OPENBOT_BUILD_${part}=\${XIONGBAO_BUILD_${part}}`,
      );
  });
});
