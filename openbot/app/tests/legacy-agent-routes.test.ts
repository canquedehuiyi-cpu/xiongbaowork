import { expect, test } from "bun:test";
import {
  LEGACY_PAGES,
  LEGACY_RESOURCE_TABS,
  legacyAgentsTarget,
  legacyAssembleTarget,
  legacyConnectedAccountsTarget,
  legacyConnectedAccountTarget,
  legacyResourcesTarget,
  legacyResponsibilitiesTarget,
  legacySkillsTarget,
  legacyWakersTarget,
  legacyWakerTarget,
} from "@/lib/agents/legacy-routes";

test("/agents?agent=<id> opens that Bot's page", () => {
  expect(legacyAgentsTarget({ agent: "agent_1" })).toEqual({
    to: "/bots/$agentId",
    params: { agentId: "agent_1" },
    replace: true,
  });
});

test("/agents?new=true opens the new-Bot wizard on the roster", () => {
  expect(legacyAgentsTarget({ new: true })).toEqual({
    to: "/bots",
    search: { new: true },
    replace: true,
  });
});

test("/agents on its own is the roster", () => {
  expect(legacyAgentsTarget({})).toEqual({ to: "/bots", replace: true });
});

test("creating wins over opening, as it did on /agents", () => {
  expect(legacyAgentsTarget({ new: true, agent: "agent_1" }).to).toBe("/bots");
});

test("pages that left the sidebar send people to where their contents went", () => {
  // 熊宝版：/reachability（@Waker）留在主导航，/responsibilities 只在带 ?agent= 时转走，所以都不在这张表里。
  expect(LEGACY_PAGES).toEqual({
    "/approvals": "/settings/approvals",
    "/memory": "/capabilities/memory",
    "/group/new": "/channel/new",
    "/team-bots": "/bots",
    "/knowledge": "/capabilities/knowledge",
    "/role-templates": "/capabilities/roles",
    "/plans": "/settings/plans",
    "/platform": "/admin/platform",
  });
});

test("/wakers carries its filters, the groups tab and the create dialog to /bots", () => {
  expect(
    legacyWakersTarget({
      tab: "groups",
      q: "张",
      status: "paused",
      role: "运营",
      env: "device",
      sort: "recent",
    }),
  ).toEqual({
    to: "/bots",
    search: {
      tab: "groups",
      q: "张",
      status: "paused",
      role: "运营",
      env: "device",
      sort: "recent",
    },
    replace: true,
  });
  expect(legacyWakersTarget({ new: true })).toEqual({
    to: "/bots",
    search: { new: true },
    replace: true,
  });
  expect(legacyWakersTarget({})).toEqual({
    to: "/bots",
    search: {},
    replace: true,
  });
});

test("/wakers?agent=<id> opens that employee's page; creating still wins", () => {
  expect(legacyWakersTarget({ agent: "agent_1", q: "x" })).toEqual({
    to: "/bots/$agentId",
    params: { agentId: "agent_1" },
    replace: true,
  });
  expect(legacyWakersTarget({ agent: "agent_1", new: true }).to).toBe("/bots");
});

test("an employee's old detail and assembly pages land on its own page", () => {
  expect(legacyWakerTarget("agent_1")).toEqual({
    to: "/bots/$agentId",
    params: { agentId: "agent_1" },
    replace: true,
  });
  expect(legacyAssembleTarget("agent_1")).toEqual({
    to: "/bots/$agentId/setup",
    params: { agentId: "agent_1" },
    replace: true,
  });
});

test("/responsibilities?agent=X opens X's responsibilities; without it the page stays", () => {
  expect(legacyResponsibilitiesTarget({ agent: "agent_1" })).toEqual({
    to: "/bots/$agentId/responsibilities",
    params: { agentId: "agent_1" },
    replace: true,
  });
  expect(legacyResponsibilitiesTarget({})).toBeNull();
});

test("each /resources tab has a new home; sources is memory and connectors is Connections", () => {
  expect(LEGACY_RESOURCE_TABS).toEqual({
    plugins: "/capabilities/plugins",
    skills: "/capabilities/skills",
    connectors: "/connections",
    knowledge: "/capabilities/knowledge",
    wakerflows: "/capabilities/wakerflows",
    projects: "/capabilities/projects",
    models: "/capabilities/models",
    components: "/capabilities/components",
    sources: "/capabilities/memory",
  });
});

test("/resources without a tab is the plugins tab, with its own parameters", () => {
  expect(
    legacyResourcesTarget({ view: "mine", category: "office", page: 2, q: "表" }),
  ).toEqual({
    to: "/capabilities/plugins",
    search: { view: "mine", category: "office", page: 2, q: "表" },
    replace: true,
  });
  expect(legacyResourcesTarget({})).toEqual({
    to: "/capabilities/plugins",
    search: {},
    replace: true,
  });
});

test("/resources?tab=skills and /skills keep new and edit", () => {
  const skills = {
    to: "/capabilities/skills",
    search: { new: true, edit: "weekly" },
    replace: true,
  };
  expect(legacyResourcesTarget({ tab: "skills", new: true, edit: "weekly" })).toEqual(skills);
  expect(legacySkillsTarget({ new: true, edit: "weekly" })).toEqual(skills);
});

test("the searchable tabs keep the search; the others take nothing", () => {
  expect(legacyResourcesTarget({ tab: "knowledge", q: "合同" })).toEqual({
    to: "/capabilities/knowledge",
    search: { q: "合同" },
    replace: true,
  });
  expect(legacyResourcesTarget({ tab: "sources", q: "x" })).toEqual({
    to: "/capabilities/memory",
    replace: true,
  });
  expect(legacyResourcesTarget({ tab: "connectors" })).toEqual({
    to: "/connections",
    replace: true,
  });
});

test("old connected-account addresses keep the consent's report on the way to Connections", () => {
  expect(
    legacyConnectedAccountsTarget({ connected: "notion", linked: "github" }),
  ).toEqual({
    to: "/connections",
    search: { connected: "notion", linked: "github" },
    replace: true,
  });
  expect(
    legacyConnectedAccountTarget("github", { action: "send", connect: true }),
  ).toEqual({
    to: "/connections/$key",
    params: { key: "github" },
    search: { action: "send", connect: true },
    replace: true,
  });
});
