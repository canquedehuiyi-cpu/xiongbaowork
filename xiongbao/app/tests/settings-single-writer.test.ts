import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appSources, stripComments } from "./i18n-accessible";

/*
 * 每个设置只有一个写入点（spec §10.3、§5.4）：写设置的 mutation，每个（mutation, 键）在
 * `app/src/components` 与 `app/src/routes` 下只被一个文件引用。
 *
 * 「键」怎么认（静态、够用即可，不求完美）：
 * - 审批、网络策略这几个不分键的 mutation，键就是 `*`。
 * - 企业设置按 `setSetting("k", …)` / `onSetting("k", …)` 的字面量，以及引用它的文件里
 *   `.mutate({ key: "k" … })` 的字面量；都没有字面量（键是变量）记为 `(动态)`。
 * - 能力开关按引用它的文件里 `.mutate({ capability: "k" … })` 的字面量，没有记 `(动态)`。
 *
 * 今天不满足的组进 settings-single-writer-pending.json，后续 PR 每合并一处就删一条；
 * 清单**只收窄**：新增违规会红，已经不违规的条目也会红（逼着把它删掉）。
 */

type Mutation = {
  name: string;
  /** 额外读出这个文件写的是哪些键；返回空数组表示键是动态的。 */
  keys?: (source: string, referencing: boolean) => string[];
};

/** 把 `open` 位置的括号配平，返回括号里的文本。 */
function argumentsAt(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return source.slice(open + 1);
}

function literalsInMutateCalls(source: string, field: string): string[] {
  const found: string[] = [];
  for (const call of source.matchAll(/\.mutate(?:Async)?\(/g)) {
    const text = argumentsAt(source, (call.index ?? 0) + call[0].length - 1);
    for (const match of text.matchAll(
      new RegExp(`\\b${field}:\\s*"(\\w+)"`, "g"),
    )) {
      found.push(match[1] as string);
    }
  }
  return found;
}

const MUTATIONS: Mutation[] = [
  { name: "setApprovalPreferences" },
  { name: "setApprovalEnabled" },
  { name: "approvalPreferencesMutationOptions" },
  { name: "teamApprovalSettingsMutationOptions" },
  { name: "setNetworkPolicyMutationOptions" },
  {
    name: "setCapabilityMutationOptions",
    keys: (source, referencing) =>
      referencing ? literalsInMutateCalls(source, "capability") : [],
  },
  {
    name: "setEnterpriseSettingMutationOptions",
    keys: (source, referencing) => [
      ...[...source.matchAll(/\b(?:setSetting|onSetting)\(\s*"(\w+)"/g)].map(
        (match) => match[1] as string,
      ),
      ...(referencing ? literalsInMutateCalls(source, "key") : []),
    ],
  },
];

/**
 * 固定的例外（不会随后续 PR 消失）：首次引导里的「改动前先问我」开关和审批与安全页是同一份数据的
 * 两个入口，引导是一次性流程、不算设置页（spec §5.4 第一行）。
 */
const FIXED_EXCEPTION = "app/src/components/onboarding/ask-first-switch.tsx";

type PendingEntry = {
  mutation: string;
  key: string;
  files: string[];
  reason: string;
};

const PENDING: PendingEntry[] = JSON.parse(
  readFileSync(
    new URL("./settings-single-writer-pending.json", import.meta.url),
    "utf8",
  ),
);

const DYNAMIC = "(动态)";

/** 组 `mutation key` → 写它的文件（排序、去重）。 */
function writersByGroup(
  sources: { file: string; source: string }[],
): Map<string, string[]> {
  const groups = new Map<string, Set<string>>();
  for (const { file, source } of sources) {
    if (
      !file.startsWith("app/src/components/") &&
      !file.startsWith("app/src/routes/")
    ) {
      continue;
    }
    if (file === FIXED_EXCEPTION) continue;
    const code = stripComments(source);
    for (const mutation of MUTATIONS) {
      const referencing = new RegExp(`\\b${mutation.name}\\b`).test(code);
      let keys: string[];
      if (!mutation.keys) {
        if (!referencing) continue;
        keys = ["*"];
      } else {
        keys = mutation.keys(code, referencing);
        if (keys.length === 0) {
          if (!referencing) continue;
          keys = [DYNAMIC];
        }
      }
      for (const key of new Set(keys)) {
        const group = `${mutation.name} ${key}`;
        groups.set(group, (groups.get(group) ?? new Set()).add(file));
      }
    }
  }
  return new Map(
    [...groups].map(([group, files]) => [group, [...files].sort()]),
  );
}

describe("写设置的 mutation 只被一个组件文件引用", () => {
  const sources = appSources();
  const groups = writersByGroup(sources);
  const pendingKey = (entry: PendingEntry) => `${entry.mutation} ${entry.key}`;

  test("量具没有扫空：今天确实有写设置的文件", () => {
    expect(groups.size).toBeGreaterThan(0);
    expect(groups.get("setApprovalEnabled *")).toEqual([
      "app/src/components/approvals/inbox.tsx",
    ]);
  });

  test("固定例外还在用 mutation（不在就删掉这条例外）", () => {
    const source = sources.find((entry) => entry.file === FIXED_EXCEPTION);
    expect(source?.source).toContain("approvalPreferencesMutationOptions");
  });

  test("没有新的多写入点：多于一个文件的组都在 PENDING 里，且文件一字不差", () => {
    const offenders = [...groups]
      .filter(([, files]) => files.length > 1)
      .filter(([group, files]) => {
        const entry = PENDING.find((item) => pendingKey(item) === group);
        return (
          !entry ||
          JSON.stringify([...entry.files].sort()) !== JSON.stringify(files)
        );
      })
      .map(([group, files]) => `${group}: ${files.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  test("PENDING 只收窄：每条都还在违规（已经只剩一个写入点的要删掉）", () => {
    const stale = PENDING.filter(
      (entry) => (groups.get(pendingKey(entry))?.length ?? 0) <= 1,
    ).map(pendingKey);
    expect(stale).toEqual([]);
  });

  test("PENDING 每条写了原因，没有重复的组", () => {
    expect(PENDING.filter((entry) => !entry.reason.trim())).toEqual([]);
    const keys = PENDING.map(pendingKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("量具自检：合成源码", () => {
  const sources = (files: Record<string, string>) =>
    Object.entries(files).map(([file, source]) => ({ file, source }));

  test("两个文件引用同一个不分键的 mutation 记为同一组", () => {
    const groups = writersByGroup(
      sources({
        "app/src/components/a.tsx": "useMutation(setApprovalEnabled)",
        "app/src/routes/b.tsx": "useMutation(setApprovalEnabled)",
        "app/src/lib/c.ts": "setApprovalEnabled",
      }),
    );
    expect(groups.get("setApprovalEnabled *")).toEqual([
      "app/src/components/a.tsx",
      "app/src/routes/b.tsx",
    ]);
  });

  test("企业设置按键字面量分组，注释里的引用不算", () => {
    const groups = writersByGroup(
      sources({
        "app/src/components/a.tsx": `
          // setEnterpriseSettingMutationOptions 只在注释里
          setSetting("modelAllowlist", 1)`,
        "app/src/components/b.tsx": `
          const s = useMutation(setEnterpriseSettingMutationOptions(q));
          s.mutate({ key: "ssoRequired", value: true });`,
        "app/src/components/c.tsx": `
          const s = useMutation(setEnterpriseSettingMutationOptions(q));
          s.mutate({ key, value });`,
      }),
    );
    expect(
      groups.get("setEnterpriseSettingMutationOptions modelAllowlist"),
    ).toEqual(["app/src/components/a.tsx"]);
    expect(
      groups.get("setEnterpriseSettingMutationOptions ssoRequired"),
    ).toEqual(["app/src/components/b.tsx"]);
    expect(
      groups.get(`setEnterpriseSettingMutationOptions ${DYNAMIC}`),
    ).toEqual(["app/src/components/c.tsx"]);
  });

  test("能力开关按 capability 字面量分组；固定例外文件不计", () => {
    const groups = writersByGroup(
      sources({
        "app/src/routes/p.tsx": `
          useMutation(setCapabilityMutationOptions(q));
          set.mutate({ scopeKind: "organization", capability: "proactive" });`,
        [FIXED_EXCEPTION]: "approvalPreferencesMutationOptions(q)",
      }),
    );
    expect(groups.get("setCapabilityMutationOptions proactive")).toEqual([
      "app/src/routes/p.tsx",
    ]);
    expect(groups.has("approvalPreferencesMutationOptions *")).toBe(false);
  });
});
