import { expect, test } from "bun:test";
import { loadTenantPackage } from "../src/tenant-package";

/**
 * 「造员工」技能（`bot-creator`）不声明 tools。招聘与组群工具靠员工自己的授予生效（小管家默认有），
 * 技能上声明不会多给任何东西；可一旦声明，这一轮就按技能挑工具（`plugins/selection.ts`），用户确认卡片之后
 * 的那一轮挑中的技能可能不再是它，`proposal_status` 就被收走了。说明里照样写清楚该用哪个工具。
 */
const PACKAGES = [
  "../examples/xiongbao",
  "../examples/personal",
  "../examples/fintech",
];

for (const path of PACKAGES)
  test(`${path} ships bot-creator without declared tools and still names the staffing tools`, async () => {
    const loaded = await loadTenantPackage(path);
    const skill = loaded.skills.find((entry) => entry.slug === "bot-creator");

    expect(skill?.tools).toEqual([]);
    expect(skill?.instructions).toContain("mcp__staffing__propose_employee");
  });
