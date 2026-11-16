// The Windows half of `typecheck-tests.ts`: the baseline must be the same on a laptop, in a worktree
// and on CI, and that promise is kept by stripping the checkout prefix out of every diagnostic.
//
// It was broken on Windows and silently so. `repoRoot` comes from `path.resolve()`, which hands back
// `C:\Users\…` — backslashes — while tsc prints resolved paths as `C:/Users/…`. `replaceAll` therefore
// matched nothing, the absolute path stayed in the key, and the same error read as NEW on Windows and
// as pre-existing on Linux. Eight errors flipped that way in both directions at once (eight "NEW" and
// eight "no longer occur"), which is exactly the shape that teaches people to run `--update` without
// reading — the failure mode the script's own header calls out.
//
// These tests pin the strip, not the tsc run: the run needs the whole project and a few minutes.

import { describe, expect, test } from "bun:test";
import { parseDiagnostics, stripRepoRoot, subtract } from "./typecheck-tests";

const WINDOWS_ROOT =
  "C:\\Users\\canqu\\WorkBuddy\\熊宝数字员工\\xiongbaowork\\xiongbao";
const POSIX_ROOT = "/home/runner/work/xiongbaowork/xiongbaowork/xiongbao";

const GALLERY_MESSAGE =
  'Module "../../app/src/components/gallery/charts" was resolved to ' +
  '"C:/Users/canqu/WorkBuddy/熊宝数字员工/xiongbaowork/xiongbao/app/src/components/gallery/charts.tsx", ' +
  "but '--jsx' is not set.";

describe("stripRepoRoot", () => {
  test("Windows root strips a forward-slash path — the case that was broken", () => {
    const stripped = stripRepoRoot(GALLERY_MESSAGE, WINDOWS_ROOT);
    expect(stripped).not.toContain("C:/Users");
    expect(stripped).toContain('"app/src/components/gallery/charts.tsx"');
  });

  test("Windows root also strips a backslash path", () => {
    const message = `resolved to "${WINDOWS_ROOT}\\app\\src\\x.tsx", but nothing`;
    expect(stripRepoRoot(message, WINDOWS_ROOT)).toBe(
      'resolved to "app\\src\\x.tsx", but nothing',
    );
  });

  test("a POSIX root still strips as before", () => {
    const message = `resolved to "${POSIX_ROOT}/app/src/x.tsx", but nothing`;
    expect(stripRepoRoot(message, POSIX_ROOT)).toBe(
      'resolved to "app/src/x.tsx", but nothing',
    );
  });

  test("a path outside the checkout is left alone", () => {
    const message =
      'Cannot find module "some-package" from "node_modules/other/index.js"';
    expect(stripRepoRoot(message, WINDOWS_ROOT)).toBe(message);
  });

  test("stripping twice changes nothing — keys must be comparable across runs", () => {
    const once = stripRepoRoot(GALLERY_MESSAGE, WINDOWS_ROOT);
    expect(stripRepoRoot(once, WINDOWS_ROOT)).toBe(once);
  });
});

describe("parseDiagnostics", () => {
  test("a Windows resolved path yields the same key as the pre-stripped one", () => {
    const withPath = `server/tests/a.test.ts(3,7): error TS6142: ${GALLERY_MESSAGE}`;
    const bare =
      'server/tests/a.test.ts: error TS6142: Module "../../app/src/components/gallery/charts" ' +
      "was resolved to \"app/src/components/gallery/charts.tsx\", but '--jsx' is not set.";

    const keys = parseDiagnostics(withPath, WINDOWS_ROOT).map((d) => d.key);
    expect(keys).toEqual([bare]);
  });

  test("indented elaboration lines are dropped, not counted as errors", () => {
    const output = [
      "server/tests/a.test.ts(3,7): error TS2322: Type 'a' is not assignable to type 'b'.",
      "  Types of property 'x' are incompatible.",
      "    Type 'number' is not assignable to type 'string'.",
    ].join("\n");
    expect(parseDiagnostics(output, POSIX_ROOT)).toHaveLength(1);
  });

  test("position is kept for reporting but never enters the key", () => {
    const a = parseDiagnostics(
      "server/tests/a.test.ts(3,7): error TS2322: boom",
      POSIX_ROOT,
    );
    const b = parseDiagnostics(
      "server/tests/a.test.ts(99,1): error TS2322: boom",
      POSIX_ROOT,
    );
    expect(a[0]!.key).toBe(b[0]!.key);
    expect(a[0]!.line).toBe(3);
    expect(b[0]!.line).toBe(99);
  });
});

describe("subtract", () => {
  test("is a multiset difference — one extra copy of a known error is still new", () => {
    const same = "server/tests/a.test.ts: error TS2322: boom";
    expect(subtract([same, same], [same])).toEqual([same]);
    expect(subtract([same], [same, same])).toEqual([]);
  });
});
