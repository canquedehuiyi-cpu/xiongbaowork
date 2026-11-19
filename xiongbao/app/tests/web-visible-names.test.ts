import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) =>
  readFileSync(join(import.meta.dir, "..", file), "utf8");

// What a person's browser or a page's own markup carries must not say the upstream name. The
// notification tag in lib/notifications/show.ts is held back: component-reply-notice.test.tsx still
// asserts `openbot-${channel.id}` (appendix A of the gradual-rewrite plan).
const NAMES = [
  {
    file: "src/components/browser/learning-next.tsx",
    now: "xiongbao-learned-",
    before: "openbot-learned-",
  },
  {
    file: "src/components/computer/computer-view.tsx",
    now: 'id="xiongbao-secret"',
    before: "openbot-secret",
  },
  {
    file: "src/components/layout/openbot-version.tsx",
    now: 'data-slot="xiongbao-version"',
    before: "openbot-version",
  },
];

for (const { file, now, before } of NAMES) {
  test(`${file} says ${now}, not ${before}`, () => {
    const source = read(file);
    expect(source).toContain(now);
    expect(source).not.toContain(before);
  });
}

test("computer-view's secret label points at the renamed input", () => {
  expect(read("src/components/computer/computer-view.tsx")).toContain(
    'htmlFor="xiongbao-secret"',
  );
});

test("the stopped-turn console warning names the product from the app config", () => {
  const source = read("src/lib/copilot/stopped-turn.ts");
  expect(source).toContain("连不上后端。");
  expect(source).toContain("productName()");
  expect(source).not.toContain("OpenBot couldn't reach");
});

test("the responsibilities page names only the new inbound-email settings", () => {
  const source = read("src/routes/_authed/_app/responsibilities.tsx");
  expect(source).toContain("XIONGBAO_INBOUND_EMAIL_SNS_TOPIC_ARNS");
  expect(source).not.toContain("旧名 OPENBOT_");
});
