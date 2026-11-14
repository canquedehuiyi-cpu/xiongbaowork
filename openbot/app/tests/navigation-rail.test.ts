import { expect, test } from "bun:test";
import { NAVIGATION, railForPath } from "@/lib/navigation";

const RAILS = ["msg", "contacts", "work", "me"];

test("每个导航项都有入口归属", () => {
  for (const item of NAVIGATION) expect(RAILS).toContain(item.rail);
});

const CASES: [string, string][] = [
  ["/", "msg"],
  ["/channel/x", "msg"],
  ["/group/x", "msg"],
  ["/channel/new", "msg"],
  ["/bots", "contacts"],
  ["/bots/a/setup", "contacts"],
  ["/assemble/a", "contacts"],
  ["/tasks", "work"],
  ["/autonomous", "work"],
  ["/reachability", "work"],
  ["/capabilities/skills", "work"],
  ["/connections", "work"],
  ["/browser", "work"],
  ["/pipelines", "work"],
  ["/team-bots", "work"],
  ["/approvals", "work"],
  ["/admin/audit", "work"],
  ["/workbench", "work"],
  ["/settings", "me"],
  ["/settings/plans", "me"],
  ["/me", "me"],
  ["/nowhere", "msg"],
];

test("railForPath 按归属表返回入口", () => {
  for (const [path, rail] of CASES)
    expect([path, railForPath(path)]).toEqual([path, rail]);
});
