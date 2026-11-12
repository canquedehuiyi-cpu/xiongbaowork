import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents as agentTable,
  channelAgents,
  channels,
  deploymentPackages,
  pluginGrants,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import type { LoadedTenantPackage } from "../src/tenant-package";
import {
  synchronizeTenantPackage,
  validateTenantPackage,
} from "../src/tenant-package";
import type { PackageTeam } from "../src/tenant-package-capabilities";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A brand package's expert teams, from `teams.yaml` to a channel and a pair of grants (4b-B1).
 *
 * A team materializes THREE things and no table of its own: a `channels` row under the team's id
 * (riding every path a declared channel already rides, including the retire sweep), the members in it
 * through `channel_agents`, and the bot-to-bot grants that say WHO MAY @ WHOM. The grant's direction
 * is the contract and is asserted by column name: agentId is the INITIATOR (the address rule's
 * `from`), ref the recipient — reversed, a lead that cannot dispatch and a member that can summon.
 *
 * The lead's prompt is the fourth, derived thing: it learns its members and the hand-off rule from
 * the same declaration, so a seeded lead does not have to guess who it leads.
 *
 * The package is synthetic under this suite's tenant key, as in `tenant-package-switch-retires`.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantKey = `pkg-teams-tenant-${suite}`;

const teamAgent = (id: string) => ({
  id,
  name: `员工 ${id}`,
  title: `岗位 ${id}`,
  roleDescription: `只用于专家团测试的 ${id}`,
  type: "built_in" as const,
  configuration: { systemPrompt: `我是 ${id}。` },
  skills: [],
});

const team = (overrides: Partial<PackageTeam> = {}): PackageTeam => ({
  id: `team-${suite}`,
  name: "软件公司",
  description: "一个 lead 带两个成员。",
  lead: `lead-${suite}`,
  members: [
    { id: `pm-${suite}`, role: "产品经理" },
    { id: `arch-${suite}`, role: "架构师" },
  ],
  address: [
    { from: `lead-${suite}`, to: [`pm-${suite}`, `arch-${suite}`] },
    { from: `pm-${suite}`, to: [`lead-${suite}`] },
  ],
  ...overrides,
});

const packageWith = (
  agents: ReturnType<typeof teamAgent>[],
  teams: PackageTeam[],
  checksumSuffix: string,
): LoadedTenantPackage => ({
  tenantId: tenantKey,
  formerTenantIds: [],
  productName: "专家团同步测试",
  stylesheet: null,
  agents,
  omittedAgentIds: [],
  channels: [],
  model: {
    provider: "openai",
    credentialSecretRef: "TEAMS_TEST_KEY",
    defaultModel: "test-model",
  },
  knowledgeSources: [],
  skills: [],
  teams,
  themeCss: "",
  sourcePath: `tests/fixtures/teams-${suite}`,
  checksum: `teams-${checksumSuffix}-${suite}`,
});

const roster = () => [
  teamAgent(`lead-${suite}`),
  teamAgent(`pm-${suite}`),
  teamAgent(`arch-${suite}`),
];

const applyPackage = (tenantPackage: LoadedTenantPackage) =>
  runAsTenant("platform", () =>
    synchronizeTenantPackage(database, tenantPackage),
  );

const teamChannel = async () =>
  await runAsTenant("platform", () =>
    database
      .select()
      .from(channels)
      .where(eq(channels.id, `team-${suite}`))
      .limit(1),
  );

const channelBots = async () =>
  await runAsTenant("platform", () =>
    database
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(eq(channelAgents.channelId, `team-${suite}`)),
  );

const botGrants = async () =>
  await runAsTenant("platform", () =>
    database
      .select({
        agentId: pluginGrants.agentId,
        ref: pluginGrants.ref,
        grantedBy: pluginGrants.grantedBy,
      })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.kind, "bot"), like(pluginGrants.ref, `%${suite}`)),
      ),
  );

const leadPrompt = async () =>
  await runAsTenant("platform", () =>
    database
      .select({ configuration: agentTable.configuration })
      .from(agentTable)
      .where(eq(agentTable.id, `lead-${suite}`))
      .limit(1),
  ).then((rows) => rows[0]?.configuration);

const agentIds = () => [`lead-${suite}`, `pm-${suite}`, `arch-${suite}`];

afterEach(async () => {
  await runAsTenant("platform", async () => {
    await database
      .delete(pluginGrants)
      .where(
        inArray(pluginGrants.agentId, [...agentIds(), `stranger-${suite}`]),
      );
    await database
      .delete(channelAgents)
      .where(eq(channelAgents.channelId, `team-${suite}`));
    await database.delete(channels).where(eq(channels.id, `team-${suite}`));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, agentIds()));
    await database.delete(agentTable).where(inArray(agentTable.id, agentIds()));
  });
});

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database
      .delete(pluginGrants)
      .where(
        inArray(pluginGrants.agentId, [...agentIds(), `stranger-${suite}`]),
      );
    await database
      .delete(channelAgents)
      .where(eq(channelAgents.channelId, `team-${suite}`));
    await database.delete(channels).where(eq(channels.id, `team-${suite}`));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, agentIds()));
    await database.delete(agentTable).where(inArray(agentTable.id, agentIds()));
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.tenantId, tenantKey));
  });
  await database.$client.close();
});

/**
 * A full package document set, as `validateTenantPackage` reads it — the boundary the two refusal
 * tests below exercise, because the sync trusts a loaded package and the refusals live at load.
 */
const filesWith = (
  agentsYaml: string,
  teamsYaml: string,
  channelsYaml: string,
) => ({
  brand: `tenant: { id: pkg-teams, product_name: TeamsTest }`,
  agents: agentsYaml,
  channels: channelsYaml,
  model:
    "model: { provider: openai, credential_secret_ref: key, default_model: test-model }",
  knowledge: "sources: []",
  themeCss: "",
  teams: teamsYaml,
});

describe("expert teams in a tenant package", () => {
  test("materializes the channel, its members, and grants in the declared direction", async () => {
    await applyPackage(packageWith(roster(), [team()], "v1"));

    const [channel] = await teamChannel();
    expect(channel).toBeDefined();
    expect(channel?.name).toBe("软件公司");

    const bots = (await channelBots()).map(({ agentId }) => agentId).sort();
    expect(bots).toEqual(
      [`arch-${suite}`, `lead-${suite}`, `pm-${suite}`].sort(),
    );

    const grants = await botGrants();
    // Direction by column name: agentId = the initiator (from), ref = the recipient (to).
    expect(grants).toContainEqual({
      agentId: `lead-${suite}`,
      ref: `pm-${suite}`,
      grantedBy: "tenant-package",
    });
    expect(grants).toContainEqual({
      agentId: `lead-${suite}`,
      ref: `arch-${suite}`,
      grantedBy: "tenant-package",
    });
    expect(grants).toContainEqual({
      agentId: `pm-${suite}`,
      ref: `lead-${suite}`,
      grantedBy: "tenant-package",
    });
  });

  test("the lead's system prompt carries the team and the hand-off rule", async () => {
    await applyPackage(packageWith(roster(), [team()], "v1"));
    const configuration = (await leadPrompt()) as Record<string, unknown>;
    const prompt = configuration.systemPrompt;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain(`我是 lead-${suite}。`);
    // The manifest is appended, not spliced: the author's text first.
    expect(prompt).toContain("你的团队");
    expect(prompt).toContain(`pm-${suite}（产品经理）`);
    expect(prompt).toContain(`arch-${suite}（架构师）`);
    expect(prompt).toContain("交接规则");
  });

  test("refuses a team that names an agent the package does not declare", () => {
    // The refusal lives at load, where the same rule channels.yaml gets is applied to teams.yaml.
    let message = "";
    try {
      validateTenantPackage(
        filesWith(
          `agents:\n${roster()
            .map(
              (agent) =>
                `  - id: ${agent.id}\n    name: ${agent.name}\n    title: ${agent.title}\n    role_description: ${agent.roleDescription}\n    type: built-in\n    system_prompt: ${agent.configuration.systemPrompt}`,
            )
            .join("\n")}\n`,
          `teams:\n  - id: team-${suite}\n    name: 软件公司\n    description: 成员是拼错的。\n    lead: lead-${suite}\n    members:\n      - id: stranger-${suite}\n        role: 局外人\n    address:\n      - from: lead-${suite}\n        to: [stranger-${suite}]\n`,
          "channels: []\n",
        ),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`team-${suite}`);
    expect(message).toContain(`stranger-${suite}`);
  });

  test("switching packages takes the team's channel and grants back", async () => {
    await applyPackage(packageWith(roster(), [team()], "v1"));
    expect(await teamChannel()).toHaveLength(1);

    // The same tenant, now declaring no teams: the channel sweep retires the team's channel, and the
    // wholesale grant sweep takes the bot grants back.
    await applyPackage(packageWith(roster(), [], "v2"));
    expect(await teamChannel()).toHaveLength(0);
    expect(await botGrants()).toHaveLength(0);
    // The members themselves survive: retiring a team is not retiring its coworkers.
    const survivors = await runAsTenant("platform", () =>
      database
        .select({ id: agentTable.id })
        .from(agentTable)
        .where(inArray(agentTable.id, agentIds())),
    );
    expect(survivors).toHaveLength(3);
  });

  test("refuses a team whose id is also declared in channels.yaml", () => {
    let message = "";
    try {
      validateTenantPackage(
        filesWith(
          `agents:\n${roster()
            .map(
              (agent) =>
                `  - id: ${agent.id}\n    name: ${agent.name}\n    title: ${agent.title}\n    role_description: ${agent.roleDescription}\n    type: built-in\n    system_prompt: ${agent.configuration.systemPrompt}`,
            )
            .join("\n")}\n`,
          `teams:\n  - id: team-${suite}\n    name: 软件公司\n    description: 与 channels.yaml 撞名。\n    lead: lead-${suite}\n    members:\n      - id: pm-${suite}\n    address: []\n`,
          `channels:\n  - id: team-${suite}\n    name: 撞名的频道\n    description: 与 teams.yaml 同 id。\n    permitted_agents: [lead-${suite}]\n    allowed_groups: []\n`,
        ),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`team-${suite}`);
    expect(message).toContain("both teams.yaml and channels.yaml");
  });
});
