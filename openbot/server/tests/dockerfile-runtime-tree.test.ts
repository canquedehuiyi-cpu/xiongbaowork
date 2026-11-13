import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dockerfile = readFileSync(
  join(import.meta.dir, "../../Dockerfile"),
  "utf8",
);
// Only the final stage ships: what a builder stage copies says nothing about the image.
const runtime = dockerfile.split(/^FROM\s.*$/m).pop() ?? "";
const copies = runtime.split("\n").filter((line) => /^COPY\s/.test(line));

describe("the runtime image's tree", () => {
  test("the runtime stage no longer copies the whole server directory from the build context", () => {
    expect(copies).not.toContain("COPY server server");
    expect(copies).not.toContain("COPY shared shared");
    expect(copies).not.toContain("COPY toolkit toolkit");
    expect(copies).not.toContain("COPY examples examples");
    expect(
      copies.some((line) => /^COPY --from=runtime-src\s.*\sserver\/?$/.test(line)),
    ).toBe(true);
  });

  test("a runtime-src stage deletes the tests, docs and non-tenant examples", () => {
    const stage = dockerfile.split(/^FROM\s/m).find((s) => s.includes("AS runtime-src")) ?? "";
    expect(stage).not.toBe("");
    for (const gone of [
      "server/tests",
      "server/docs",
      "server/tsconfig.tests.json",
      "toolkit/tests",
    ])
      expect(stage, gone).toContain(gone);
    expect(stage).toContain("-delete");
  });

  test("the build identity is XIONGBAO_BUILD_*, with no OPENBOT_BUILD_ build argument left", () => {
    expect(dockerfile).toContain("ARG XIONGBAO_BUILD_VERSION");
    expect(dockerfile).not.toContain("ARG OPENBOT_BUILD_");
  });
});
