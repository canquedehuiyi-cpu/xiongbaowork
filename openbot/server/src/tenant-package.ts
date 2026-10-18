import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { parse } from "yaml";
import { DEPLOYMENT_ROUTES } from "./computer/deployment-routes";
import type { Database } from "./db/client";
import {
  agentProfiles,
  agents as agentTable,
  channelAgents,
  channelMemberships,
  channels as channelTable,
  deploymentPackages,
  intelligenceChannelMappings,
  pluginGrants,
  skills as skillTable,
  skillTools,
  users,
} from "./db/schema";
import { SYSTEM_TENANT } from "./db/schema/tenant";
import { runAsTenant } from "./tenant/context";
import { packageChannelId } from "./tenant/provisioning";

const approvedThemeVariables = new Set([
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--radius",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
]);

export function validateThemeCss(rawCss: string) {
  /*
   * A comment is not something a theme defines, so it is taken out before anything below reads the
   * text as definitions.
   *
   * Every rule here is about what a theme may DEFINE — two blocks, approved variables, no imports
   * and no URLs — and a comment defines nothing. They were applied to the raw file anyway, so a
   * stylesheet carrying the line every hand-written stylesheet opens with, saying whose brand it is
   * and where the colours came from, was refused twice over. Above the blocks it survived the
   * removal of them and read as a second selector: "Tenant theme may only define :root and .dark
   * blocks". Inside one it was split on the semicolons around it and read as a variable name, so the
   * refusal quoted the comment back as the variable it was not. A tenant package is loaded at
   * start-up, so neither of those is a warning: the deployment does not come up, over a comment, and
   * says nothing about comments.
   *
   * Taking them out first is stricter than leaving them in, never weaker. A comment wedged into the
   * middle of the word `url` makes something a browser does not read as a URL token, and the test
   * below did not read it as one either; with the comment gone, both do, and it is refused. A
   * comment that is never closed does not match and is not removed, so it stays as the nonsense it
   * is and is still refused. What a comment cannot do here is hide anything: what is left once they
   * are gone is what a browser would act on.
   */
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, " ");

  if (/@import|url\s*\(/i.test(css)) {
    throw new Error("Tenant theme must not contain imports or URLs");
  }

  const blocks = [...css.matchAll(/(:root|\.dark)\s*\{([^{}]*)\}/g)];
  const remaining = css.replace(/(:root|\.dark)\s*\{[^{}]*\}/g, "").trim();
  if (!blocks.length || remaining) {
    throw new Error("Tenant theme may only define :root and .dark blocks");
  }

  for (const [, , body] of blocks) {
    for (const declaration of body.split(";")) {
      const trimmed = declaration.trim();
      if (!trimmed) {
        continue;
      }
      const separator = trimmed.indexOf(":");
      const variable = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();

      if (separator < 1 || !value || !approvedThemeVariables.has(variable)) {
        throw new Error(
          `Tenant theme variable ${variable || "(invalid)"} is not an approved theme variable`,
        );
      }
    }
  }
}

type PackageFiles = {
  brand: string;
  agents: string;
  channels: string;
  model: string;
  knowledge: string;
  /**
   * Optional, unlike the five above, because packages written before skills shipped do not have it
   * and must keep loading. Absent means a deployment with no skills of its own, which is what every
   * package had until now.
   */
  skills?: string;
  /**
   * A coworker per file, from `agents/` beside `agents.yaml`, in the order they should be read.
   *
   * `agents.yaml` holds every coworker in one file, so adding one means editing a file somebody
   * else is also editing, and sending one means sending a fragment of it. A directory makes a
   * coworker a thing you can copy in, delete, or hand to somebody. Both are read, and a package
   * with only `agents.yaml` is unchanged.
   */
  agentFiles?: PackageAgentFile[];
  themeCss: string;
};

/** One file from `agents/`, kept with its name so a refusal can say which file it came from. */
export type PackageAgentFile = {
  filename: string;
  contents: string;
};

/**
 * A skill the package ships, and the tools it says it needs.
 *
 * WHY THE PACKAGE AND NOT A SCREEN. Selection narrows a Bot's tools to the ones the matching skills
 * declare, so with no skills there is nothing to match and the narrowing never switches on. Every
 * deployment starts with no skills, so left to a screen the feature is off on every clone until
 * somebody sits down and maps tools to skills by hand — in each deployment, again after each new
 * connector. That is curation work a product with a services team can absorb and a template cannot.
 *
 * So the declaration ships with the thing that declares it. A package skill names the tools it needs
 * the way it names its own instructions, and connecting the connector is the only step left.
 */
export type TenantSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  /**
   * `<serverId>/<toolName>` refs, and deliberately NOT checked against the tools this deployment has
   * seen.
   *
   * A package is written before anybody connects anything, so it names tools for connectors that may
   * not be added yet and may never be. An unknown ref has to sit there inert — the run-time
   * intersection drops it, which is why `skill_tools` carries no foreign key. Refusing to load the
   * package over one would mean a template could only ship skills for connectors it could guarantee,
   * which is none of them.
   */
  tools: string[];
};

/**
 * The mark a grant this package made carries, in `plugin_grants.granted_by`.
 *
 * Every other value there is the id of the person who pressed the button, so this cannot collide
 * with one, and it is what lets a redeploy take back only what the package gave.
 */
const PACKAGE_GRANT = "tenant-package";

type TenantAgent = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed?: string;
  type: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration: Record<string, unknown>;
  /**
   * The package skills this coworker is given, by slug.
   *
   * SAFE TO SEED, unlike an MCP grant, and for a reason worth stating rather than assuming. A skill
   * is an instruction and confers nothing: what a Bot may call is its grants, and the run-time offer
   * is always the intersection of the two, so a skill naming a tool its Bot does not hold loads
   * nothing. Seeding an MCP grant would be the opposite, since those reach a person's own account.
   *
   * Without this a fork boots with the skills its package ships attached to no Bot at all, and the
   * per-run narrowing that skills exist for is switched off until somebody opens the Skills page and
   * pairs them by hand. The pairing is the package's to state: it wrote both files.
   */
  skills: string[];
};

type TenantChannel = {
  id: string;
  name: string;
  description: string;
  permittedAgents: string[];
  allowedGroups: string[];
};

export type TenantPackage = {
  tenantId: string;
  productName: string;
  stylesheet: string | null;
  agents: TenantAgent[];
  /** Remote agents explicitly disabled by a blank endpoint, not arbitrary removed YAML rows. */
  omittedAgentIds: string[];
  channels: TenantChannel[];
  model: {
    provider: "openai" | "anthropic";
    credentialSecretRef: string;
    defaultModel: string;
  };
  /**
   * What `knowledge.yaml` says this deployment may connect to.
   *
   * Parsed and validated, and currently read by nothing. The connector that consumed it synced a
   * customer's Drive into a local index using a service account, so every person's answer came back
   * as the deployment rather than as themselves; it was removed rather than fixed. The file stays
   * part of the package contract because shipped packages carry it and validation should keep
   * refusing a malformed one, but a reader should not take the presence of this field as evidence
   * that anything acts on it.
   */
  knowledgeSources: {
    type: "google-drive" | "microsoft-onedrive";
    roots: string[];
  }[];
  /** What `skills.yaml` ships, or empty for a package that has none. */
  skills: TenantSkill[];
  themeCss: string;
};

export type LoadedTenantPackage = TenantPackage & {
  sourcePath: string;
  checksum: string;
};

export type PackageStatusReader = {
  active: () => Promise<{
    tenantId: string;
    sourcePath: string;
    checksum: string;
    loadedAt: string;
  } | null>;
};

export type ApplicationConfiguration = {
  brand: {
    tenantId: string;
    productName: string;
  };
};

/**
 * What the browser is told about this deployment at build time.
 *
 * Brand only. Which identity providers are configured used to live here too, and could not: the
 * image is built once, without any deployment's environment, so a deployment that configured Entra
 * got a sign-in screen built on a machine that had never heard of it. That answer now comes from
 * `/api/capabilities` at runtime, where the process that knows can answer.
 */
export function createApplicationConfiguration(
  tenantPackage: TenantPackage,
): ApplicationConfiguration {
  return {
    brand: {
      tenantId: tenantPackage.tenantId,
      productName: tenantPackage.productName,
    },
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * A list a package must supply, named in the error when it does not.
 *
 * Cast without checking, a missing `agents:` reaches `.map` on `undefined` and the reader gets a
 * TypeError naming neither the file nor the key. Editing YAML by hand is the first thing somebody
 * does here, so getting it wrong has to produce a sentence they can act on.
 */
function asList(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be a list`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function yaml(value: string, filename: string): Record<string, unknown> {
  try {
    return asRecord(parse(value), filename);
  } catch (error) {
    throw new Error(
      `${filename} is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/**
 * `${NAME}` in a package file, resolved from the environment.
 *
 * A package describes a deployment's Bots, and the addresses of the services behind them belong to
 * the environment rather than to the package: the same package has to be usable against a local
 * stack, a staging one and production. An unset name is an error rather than an empty string.
 */
export function expandEnvironment(
  value: string,
  filename: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name: string, fallback: string | undefined) => {
      const resolved = environment[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error(
        `${filename} refers to \${${name}}, which is not set in this environment.`,
      );
    },
  );
}

/**
 * The coworkers one YAML document declares, in the order it declares them.
 *
 * `source` names the file in any refusal, because a package can now declare coworkers in more than
 * one place and "agent.id is required" is no use when there are eleven files it could be in.
 *
 * A remote coworker whose endpoint interpolates to nothing is dropped rather than refused, and its
 * id is collected so a channel naming it is dropped too. That is what lets a package carry a row
 * for a Bot somebody has not picked yet.
 */
function parseAgents(
  values: unknown[],
  source: string,
  omittedAgentIds: Set<string>,
): TenantAgent[] {
  return values.flatMap((value) => {
    const agent = asRecord(value, "agent");
    const type: TenantAgent["type"] | undefined =
      agent.type === "built-in"
        ? "built_in"
        : agent.type === "remote-ag-ui"
          ? "remote_ag_ui"
          : // A Mastra server, dialled through `@ag-ui/mastra` rather than an AG-UI route of its
            // own. Seedable like the others: it is an address, and the same one this deployment
            // would have been given by hand.
            agent.type === "remote-mastra"
            ? "remote_mastra"
            : undefined;
    if (!type) {
      throw new Error(
        `${source}: agent.type must be built-in, remote-ag-ui or remote-mastra`,
      );
    }
    const id = requiredString(agent.id, "agent.id");
    /*
     * A Bot may not be named after a deployment route.
     *
     * The computer router's bot-access guard steps aside for those names, and a request cannot
     * tell a Bot called `policy` from `/policy` itself, so such a Bot would be served to anybody
     * who can sign in without the guard ever being asked. A package id is the only way a Bot gets
     * a chosen id, everything created through the API being `agent_<uuid>`, so refusing it here
     * closes it rather than moving it.
     */
    if (DEPLOYMENT_ROUTES.has(id)) {
      throw new Error(
        `${source}: agent.id "${id}" is reserved for a deployment route and cannot name a Bot`,
      );
    }
    if (type === "remote_ag_ui" || type === "remote_mastra") {
      const endpoint =
        typeof agent.endpoint === "string" ? agent.endpoint.trim() : "";
      if (!endpoint) {
        omittedAgentIds.add(id);
        return [];
      }
    }
    return [
      {
        id,
        name: requiredString(agent.name, "agent.name"),
        title: requiredString(agent.title, "agent.title"),
        roleDescription: requiredString(
          agent.role_description,
          "agent.role_description",
        ),
        avatarSeed:
          agent.avatar_seed === undefined
            ? undefined
            : requiredString(agent.avatar_seed, "agent.avatar_seed"),
        type,
        configuration:
          type === "built_in"
            ? {
                systemPrompt: requiredString(
                  agent.system_prompt,
                  "agent.system_prompt",
                ),
              }
            : {
                endpoint: requiredString(agent.endpoint, "agent.endpoint"),
                /*
                 * Which agent on that server, when the server is a roster.
                 *
                 * Optional, and only meaningful for Mastra: a package naming one gets that one,
                 * and a package naming none gets the only agent there or a refusal. Carried here
                 * so a seeded Mastra Bot is as specific as one added by hand. See
                 * `pickFromRoster`.
                 */
                ...(type === "remote_mastra" &&
                typeof agent.remote_agent_id === "string" &&
                agent.remote_agent_id.trim().length > 0
                  ? { remoteAgentId: agent.remote_agent_id.trim() }
                  : {}),
              },
        skills:
          agent.skills === undefined || agent.skills === null
            ? []
            : stringArray(agent.skills, "agent.skills"),
      },
    ];
  });
}

/**
 * Every coworker the package declares: `agents.yaml` first, then one file at a time from `agents/`.
 *
 * A file under `agents/` may hold a list under `agents:`, the way `agents.yaml` does, or the one
 * coworker on its own. The second is the point of the directory — a coworker somebody sends you is
 * a file you drop in, not a fragment to paste into the middle of a file you already have.
 *
 * Two declarations of the same id are refused, and the refusal names both files. Preferring one
 * would make which coworker a deployment runs depend on the order a directory happened to be read
 * in, and a clone that copied a file in twice under different names would never find out.
 */
function collectAgents(
  agentsYaml: Record<string, unknown>,
  agentFiles: PackageAgentFile[],
  omittedAgentIds: Set<string>,
): TenantAgent[] {
  const agents = parseAgents(
    asList(agentsYaml.agents, "agents.yaml agents"),
    "agents.yaml",
    omittedAgentIds,
  );
  // The same refusal within `agents.yaml` as across files. Sync upserts one row per entry, so a
  // repeated id there was not refused but silently became whichever entry came last.
  const declaredIn = new Map<string, string>();
  for (const agent of agents) {
    if (declaredIn.has(agent.id)) {
      throw new Error(`agent "${agent.id}" is declared twice in agents.yaml`);
    }
    declaredIn.set(agent.id, "agents.yaml");
  }
  for (const file of agentFiles) {
    const source = `agents/${file.filename}`;
    const document = yaml(file.contents, source);
    const values =
      document.agents === undefined
        ? [document]
        : asList(document.agents, `${source} agents`);
    for (const agent of parseAgents(values, source, omittedAgentIds)) {
      const existing = declaredIn.get(agent.id);
      if (existing) {
        throw new Error(
          `agent "${agent.id}" is declared in both ${existing} and ${source}`,
        );
      }
      declaredIn.set(agent.id, source);
      agents.push(agent);
    }
  }
  return agents;
}

export function validateTenantPackage(files: PackageFiles): TenantPackage {
  if (files.themeCss.trim()) {
    validateThemeCss(files.themeCss);
  }
  const brand = yaml(files.brand, "brand.yaml");
  const agentsYaml = yaml(files.agents, "agents.yaml");
  const channelsYaml = yaml(files.channels, "channels.yaml");
  const modelYaml = yaml(files.model, "model.yaml");
  const knowledgeYaml = yaml(files.knowledge, "knowledge.yaml");
  // Absent is a package with no skills, not a malformed one. A file that is present and wrong is
  // still refused, the way every other file here is.
  const skillsYaml = files.skills?.trim()
    ? yaml(files.skills, "skills.yaml")
    : {};
  const tenant = asRecord(brand.tenant, "brand.tenant");
  const skin =
    brand.skin === undefined ? undefined : asRecord(brand.skin, "brand.skin");
  const omittedAgentIds = new Set<string>();
  const agents = collectAgents(
    agentsYaml,
    files.agentFiles ?? [],
    omittedAgentIds,
  );
  const agentIds = new Set(agents.map((agent) => agent.id));
  /*
   * An id left blank in one place and declared properly in another is declared, not omitted.
   * Otherwise it was seeded and then filtered out of every channel that names it, and disabled and
   * re-enabled on each sync. A real declaration wins whichever file it is in, so the answer does not
   * depend on the order a directory is read in.
   */
  for (const id of agentIds) omittedAgentIds.delete(id);
  const packageSkills = parseTenantSkills(skillsYaml.skills);
  const skillSlugs = new Set(packageSkills.map((skill) => skill.slug));
  for (const agent of agents) {
    // Sync writes one grant row per entry in a single INSERT ... ON CONFLICT, which Postgres refuses
    // when two of its rows collide, so a repeated slug stopped the server at boot with a SQL error.
    const named = new Set<string>();
    for (const slug of agent.skills) {
      if (named.has(slug)) {
        throw new Error(`agent "${agent.id}" names skill "${slug}" twice`);
      }
      named.add(slug);
      /*
       * Checked against this package's own skills and nothing else, and refused rather than dropped.
       *
       * The two files ship together, so a slug matching none of them is a typo, and a typo that
       * silently attaches no skill is the kind nobody finds: the Bot simply never narrows and the
       * deployment looks like it is working. Deliberately not checked against skills already in the
       * deployment, because those include any a person wrote, and a package must not be able to
       * hand its Bots somebody else's instructions by naming their slug.
       */
      if (!skillSlugs.has(slug)) {
        throw new Error(
          `agent "${agent.id}" names skill "${slug}", which this package does not ship`,
        );
      }
    }
  }
  const channelIds = new Set<string>();
  const channels = asList(channelsYaml.channels, "channels.yaml channels").map(
    (value) => {
      const channel = asRecord(value, "channel");
      const id = requiredString(channel.id, "channel.id");
      // Sync upserts one channel per entry, so a repeated id silently became the last one.
      if (channelIds.has(id)) {
        throw new Error(`channel "${id}" is declared twice in channels.yaml`);
      }
      channelIds.add(id);
      const permittedAgents = stringArray(
        channel.permitted_agents,
        "channel.permitted_agents",
      ).filter((agentId) => !omittedAgentIds.has(agentId));
      // Each becomes a (channel, agent) row under a primary key, so a repeat stopped the server at
      // boot with a duplicate-key error instead of a sentence naming the channel.
      if (new Set(permittedAgents).size !== permittedAgents.length) {
        throw new Error(`channel "${id}" lists the same agent twice`);
      }
      for (const agentId of permittedAgents) {
        if (!agentIds.has(agentId)) {
          throw new Error(`channel references unknown agent "${agentId}"`);
        }
      }
      return {
        id,
        name: requiredString(channel.name, "channel.name"),
        description: requiredString(channel.description, "channel.description"),
        permittedAgents,
        allowedGroups: stringArray(
          channel.allowed_groups,
          "channel.allowed_groups",
        ),
      };
    },
  );
  const model = asRecord(modelYaml.model, "model");
  if (model.provider !== "openai" && model.provider !== "anthropic") {
    throw new Error("model.provider must be openai or anthropic");
  }
  const sources = asList(knowledgeYaml.sources, "knowledge.yaml sources").map(
    (value) => {
      const source = asRecord(value, "knowledge source");
      if (
        source.type !== "google-drive" &&
        source.type !== "microsoft-onedrive"
      ) {
        throw new Error("knowledge source type is not supported");
      }
      return {
        type: source.type,
        roots: stringArray(source.roots, "source.roots"),
      } as { type: "google-drive" | "microsoft-onedrive"; roots: string[] };
    },
  );

  return {
    tenantId: requiredString(tenant.id, "tenant.id"),
    productName: requiredString(tenant.product_name, "tenant.product_name"),
    stylesheet: skin
      ? requiredString(skin.stylesheet, "skin.stylesheet")
      : null,
    agents,
    omittedAgentIds: [...omittedAgentIds],
    channels,
    model: {
      provider: model.provider,
      credentialSecretRef: requiredString(
        model.credential_secret_ref,
        "model.credential_secret_ref",
      ),
      defaultModel: requiredString(model.default_model, "model.default_model"),
    },
    knowledgeSources: sources,
    skills: packageSkills,
    themeCss: files.themeCss,
  };
}

/**
 * The skills a package ships, as rows a deployment can be seeded with.
 *
 * A slug is what a person types after `/`, so the shape the API enforces is enforced here too: a
 * package shipping `Find A Document` would create a command nobody can type.
 */
function parseTenantSkills(value: unknown): TenantSkill[] {
  if (value === undefined || value === null) return [];
  // Sync upserts one skill per entry, so a repeated slug silently became the last one.
  const slugs = new Set<string>();
  return asList(value, "skills.yaml skills").map((entry) => {
    const skill = asRecord(entry, "skill");
    const slug = requiredString(skill.slug, "skill.slug");
    if (slugs.has(slug)) {
      throw new Error(`skill "${slug}" is declared twice in skills.yaml`);
    }
    slugs.add(slug);
    // The same pattern as the skills route, the store and the app's form. Looser, it seeded slugs
    // such as `a`, `a-` or sixty characters that none of those would accept or let anybody edit.
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug)) {
      throw new Error(
        `skill.slug "${slug}" must be lowercase letters, digits and hyphens, 2 to 40 characters, starting and ending with a letter or digit`,
      );
    }
    const tools =
      skill.tools === undefined || skill.tools === null
        ? []
        : stringArray(skill.tools, "skill.tools").map((ref) => {
            /*
             * `<serverId>/<toolName>` is the one shape a grant and a declaration share, so a ref in
             * any other shape can never match a grant and would sit in the table doing nothing.
             * Refused here rather than left to be discovered as a skill that quietly loads no tools.
             */
            if (!/^[^/\s]+\/[^/\s]+$/.test(ref)) {
              throw new Error(
                `skill.tools entry "${ref}" must be in the form serverId/toolName`,
              );
            }
            return ref;
          });
    return {
      slug,
      title: requiredString(skill.title, "skill.title"),
      summary: requiredString(skill.summary, "skill.summary"),
      instructions: requiredString(skill.instructions, "skill.instructions"),
      tools,
    };
  });
}

/**
 * The coworker files beside `agents.yaml`, read in a fixed order.
 *
 * No directory is a package that keeps every coworker in one file, which is every package written
 * before this and stays supported. `.yaml` and `.yml` only, so a README or an editor's leftovers
 * sitting in there is not something the deployment tries to parse.
 *
 * Sorted by filename rather than taken in the order the filesystem answers, because the order
 * decides which file a duplicate id is blamed on, and a refusal that names a different file on
 * another machine is not one anybody can act on.
 *
 * `${NAME}` is expanded here exactly as it is in `agents.yaml`: these are the clone's own files,
 * written by whoever wrote the rest of the package.
 */
async function readAgentFiles(sourcePath: string): Promise<PackageAgentFile[]> {
  const directory = join(sourcePath, "agents");
  const entries = await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    },
  );
  const filenames = entries
    .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
    .sort();
  return await Promise.all(
    filenames.map(async (filename) => ({
      filename,
      contents: expandEnvironment(
        await readFile(join(directory, filename), "utf8"),
        `agents/${filename}`,
      ),
    })),
  );
}

export async function loadTenantPackage(
  sourcePath: string,
): Promise<LoadedTenantPackage> {
  const filenames = [
    "brand.yaml",
    "agents.yaml",
    "channels.yaml",
    "model.yaml",
    "knowledge.yaml",
  ] as const;
  const contents = await Promise.all(
    filenames.map(async (filename) =>
      expandEnvironment(
        await readFile(join(sourcePath, filename), "utf8"),
        filename,
      ),
    ),
  );
  const [brand, agents, channels, model, knowledge] = contents;
  const themeCss = await readFile(join(sourcePath, "theme.css"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  /*
   * Optional, like `theme.css` and unlike the five required files.
   *
   * Every package written before skills shipped has no `skills.yaml`, and those packages have to go
   * on loading. Missing is a deployment with no skills of its own; present and malformed is still
   * refused.
   */
  const skills = await readFile(join(sourcePath, "skills.yaml"), "utf8")
    .then((file) => expandEnvironment(file, "skills.yaml"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  const agentFiles = await readAgentFiles(sourcePath);
  const tenantPackage = validateTenantPackage({
    brand,
    agents,
    channels,
    model,
    knowledge,
    skills,
    agentFiles,
    themeCss,
  });

  return {
    ...tenantPackage,
    sourcePath,
    // `skills` is in the checksum, so editing it is a package change like any other and the
    // deployment notices on the next boot rather than reporting itself unchanged.
    // `agents/` is in the checksum for the reason `skills` is: a coworker added, edited or removed
    // there is a package change, and a deployment that did not notice would go on running the
    // roster it booted with while the repository said otherwise.
    checksum: createHash("sha256")
      .update(
        [
          ...contents,
          skills,
          ...agentFiles.map((file) => `${file.filename}\n${file.contents}`),
        ].join("\n"),
      )
      .digest("hex"),
  };
}

export async function synchronizeTenantPackage(
  database: Database,
  tenantPackage: LoadedTenantPackage,
  /** Who to put inside every channel this package declares. See the note where it is written. */
  memberUserIds: readonly string[] = [],
) {
  /*
   * THE CATALOGUE IS WRITTEN IN THE SYSTEM PARTITION, IN THIS FUNCTION'S OWN SCOPE.
   *
   * Not in whatever scope the caller arrived in. That was invisible while there was one caller and
   * expensive once there were several: a sync run under `platform` stamps every coworker, skill and
   * channel it writes as `platform`-owned, and the next sync — production's, or another suite's, under
   * any other tenant — is refused by the UPDATE check on the row it is trying to write
   * (`42501 … for table "skills"`). Which suite can finish at all then depends on which suite ran
   * first, and on a database whose tables are shared across shards that is not a hypothetical.
   *
   * `system` is the answer for three reasons at once: it is what the boot path writes today (it
   * arrives unscoped), the read policy admits `system` rows to every tenant, and it is the partition
   * that is not somebody's workspace. The per-person channel writes stay outside this scope, in each
   * member's own, because those rows are a person's conversations rather than the deployment's
   * catalogue -- and row-level security refuses to write them from here on purpose.
   */
  const synced = await runAsTenant(
    SYSTEM_TENANT,
    async () =>
      await database.transaction(async (transaction) => {
        /*
         * A Bot already holding one of those names, from a package that declared it before this was
         * refused. Validation covers the file, and nothing here removes a canonical agent when a package
         * stops declaring one, so correcting the YAML leaves the row and the router goes on stepping
         * aside for its path. Checked inside the transaction so a deployment in that state does not come
         * up half-synchronised, and refused rather than renamed because whose Bot that is, and what
         * points at it, is not this function's to decide.
         */
        const reserved = await transaction
          .select({ id: agentTable.id })
          .from(agentTable)
          .where(inArray(agentTable.id, [...DEPLOYMENT_ROUTES]));
        if (reserved.length > 0) {
          const names = reserved.map((agent) => `"${agent.id}"`).join(", ");
          throw new Error(
            `Bot ${names} is reserved for a deployment route and cannot exist; rename or remove it before this deployment can start`,
          );
        }

        const [deploymentPackage] = await transaction
          .insert(deploymentPackages)
          .values({
            tenantId: tenantPackage.tenantId,
            sourcePath: tenantPackage.sourcePath,
            checksum: tenantPackage.checksum,
          })
          .onConflictDoUpdate({
            target: deploymentPackages.tenantId,
            set: {
              sourcePath: tenantPackage.sourcePath,
              checksum: tenantPackage.checksum,
              loadedAt: new Date(),
            },
          })
          .returning();

        if (!deploymentPackage) {
          throw new Error("Tenant package could not be synchronized");
        }

        // Disable only explicitly unconfigured agents still owned by this package. Keep canonical
        // rows and conversation memberships: runtime tombstones preserve their readable history.
        // Normal seeding below clears deletedAt if an endpoint is configured again.
        if (tenantPackage.omittedAgentIds.length > 0) {
          const now = new Date();
          await transaction
            .update(agentProfiles)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                isNull(agentProfiles.ownerUserId),
                isNull(agentProfiles.deletedAt),
                inArray(
                  agentProfiles.agentId,
                  transaction
                    .select({ id: agentTable.id })
                    .from(agentTable)
                    .where(
                      and(
                        eq(agentTable.packageId, deploymentPackage.id),
                        inArray(agentTable.id, tenantPackage.omittedAgentIds),
                      ),
                    ),
                ),
              ),
            );
        }

        for (const agent of tenantPackage.agents) {
          const updatedAt = new Date();
          const [canonicalAgent] = await transaction
            .insert(agentTable)
            .values({
              id: agent.id,
              name: agent.name,
              type: agent.type,
              configuration: agent.configuration,
              packageId: deploymentPackage.id,
            })
            .onConflictDoUpdate({
              target: agentTable.id,
              setWhere: eq(agentTable.packageId, deploymentPackage.id),
              set: {
                name: agent.name,
                type: agent.type,
                configuration: agent.configuration,
                packageId: deploymentPackage.id,
                updatedAt,
              },
            })
            .returning({ id: agentTable.id });

          if (!canonicalAgent) {
            throw new Error(
              `Tenant package agent "${agent.id}" collides with a user-created agent`,
            );
          }

          const [profile] = await transaction
            .insert(agentProfiles)
            .values({
              agentId: canonicalAgent.id,
              ownerUserId: null,
              title: agent.title,
              roleDescription: agent.roleDescription,
              avatarSeed: agent.avatarSeed ?? canonicalAgent.id,
              visibility: "public",
              deletedAt: null,
              updatedAt,
            })
            .onConflictDoUpdate({
              target: agentProfiles.agentId,
              setWhere: isNull(agentProfiles.ownerUserId),
              set: {
                ownerUserId: null,
                title: agent.title,
                roleDescription: agent.roleDescription,
                avatarSeed: agent.avatarSeed ?? canonicalAgent.id,
                visibility: "public",
                deletedAt: null,
                updatedAt,
              },
            })
            .returning({ agentId: agentProfiles.agentId });

          if (!profile) {
            throw new Error(
              `Tenant package agent "${agent.id}" collides with a user-owned profile`,
            );
          }
        }

        const members = [...new Set(memberUserIds)];

        /*
         * A channel is a person's thread list, so it cannot be stamped once into the platform's own
         * partition and then be somebody's conversation: no membership written from a person's scope can
         * reach a row the platform owns, which is what made every package channel answer "Could not load
         * this channel." (ticket 031) even after this function learned to add members.
         *
         * So when the sync knows whose workspace this is, it retires the platform-partition copies an
         * earlier boot made -- the platform may delete what it wrote -- and the rows are created after the
         * transaction, in each person's own scope, under a tenant-namespaced id. When it does not know
         * (a deployment with several people, who arrive one at a time), the old single row per declaration
         * stays: materializing per person at sign-up is ticket 004's job, and this is not the place to
         * guess at it.
         */
        /*
         * A brand that stops declaring a coworker takes it out of the roster.
         *
         * The predicate is a set difference against this package's own rows, NOT a filter on `package_id`:
         * the deployment row is keyed by tenant and upserted in place, so the id every package row carries
         * survives a switch. Filtering on the id selects nothing on a switch, which is how one deployment
         * ended up with eleven coworkers from a brand it no longer loads -- and a ghost coworker is not a
         * cosmetic problem, it is a seat in the quota and an entry in every picker.
         *
         * Retired rather than deleted. `agent_profiles.deleted_at` is what the roster, the seat count and
         * the read path already honour, while the runtime row underneath holds the memories, routines and
         * responsibilities a person built -- `ON DELETE CASCADE` is set on all of them, so deleting the row
         * would take a person's work down with a brand's rename. Switching back clears the tombstone in the
         * loop below, which writes `deletedAt: null` for everything the package declares again.
         */
        const declaredAgentIds = tenantPackage.agents.map((agent) => agent.id);
        if (declaredAgentIds.length > 0) {
          const retiredAt = new Date();
          await transaction
            .update(agentProfiles)
            .set({ deletedAt: retiredAt, updatedAt: retiredAt })
            .where(
              and(
                isNull(agentProfiles.ownerUserId),
                isNull(agentProfiles.deletedAt),
                inArray(
                  agentProfiles.agentId,
                  transaction
                    .select({ id: agentTable.id })
                    .from(agentTable)
                    .where(
                      and(
                        eq(agentTable.packageId, deploymentPackage.id),
                        notInArray(agentTable.id, declaredAgentIds),
                      ),
                    ),
                ),
              ),
            );
        }

        if (members.length === 0) {
          for (const channel of tenantPackage.channels) {
            const [ownedChannel] = await transaction
              .insert(channelTable)
              .values({
                id: channel.id,
                name: channel.name,
                description: channel.description,
                allowedGroups: channel.allowedGroups,
                packageId: deploymentPackage.id,
              })
              .onConflictDoUpdate({
                target: channelTable.id,
                setWhere: eq(channelTable.packageId, deploymentPackage.id),
                set: {
                  name: channel.name,
                  description: channel.description,
                  allowedGroups: channel.allowedGroups,
                  packageId: deploymentPackage.id,
                  updatedAt: new Date(),
                },
              })
              .returning({ id: channelTable.id });

            if (!ownedChannel) {
              throw new Error(
                `Tenant package channel "${channel.id}" collides with a channel this package does not own`,
              );
            }

            await transaction
              .delete(channelAgents)
              .where(eq(channelAgents.channelId, channel.id));
            if (channel.permittedAgents.length) {
              await transaction.insert(channelAgents).values(
                channel.permittedAgents.map((agentId) => ({
                  channelId: channel.id,
                  agentId,
                })),
              );
            }
          }

          /*
           * The same set difference for the conversations, in the platform's own partition -- the rows this
           * branch writes, and nobody else's. A channel a brand stopped declaring is a menu entry that
           * opens on a thread nobody seeds again.
           */
          const declaredChannelIds = tenantPackage.channels.map(
            (channel) => channel.id,
          );
          if (declaredChannelIds.length > 0) {
            await transaction
              .delete(channelTable)
              .where(
                and(
                  eq(channelTable.packageId, deploymentPackage.id),
                  eq(channelTable.tenantId, SYSTEM_TENANT),
                  notInArray(channelTable.id, declaredChannelIds),
                ),
              );
          }
        } else {
          /*
           * Retire the platform-partition copies an earlier boot made. They are this package's own rows
           * and the platform may delete what it wrote; leaving them in place means channels that exist
           * on every screen and open for nobody, because no membership a person can write reaches them.
           *
           * The partition is named on purpose. The package row is keyed by the tenant the brand declares,
           * so every workspace that applies this package shares its id -- deleting by `packageId` alone
           * would let one person's sync destroy the copies materialized for everybody else, which is a
           * worse bug than the one being fixed here.
           */
          await transaction
            .delete(channelTable)
            .where(
              and(
                eq(channelTable.packageId, deploymentPackage.id),
                eq(channelTable.tenantId, SYSTEM_TENANT),
              ),
            );
        }

        /*
         * Somebody has to be in a conversation before it is anybody's.
         *
         * A channel is one person's thread list, not a platform catalogue. With no membership row the
         * package's channels belong to nobody: the owner's channel list comes back empty and opening one
         * answers "Could not load this channel." That is why a roster that looks right is not evidence the
         * package worked -- the coworkers are readable because the catalogue is, and the conversations are
         * gated on membership instead.
         *
         * Only the names are checked here; the rows are written after the transaction, in each member's
         * own scope. A membership belongs to the person it names -- it carries their pin and their read
         * marker -- and row-level security says so directly: writing one into somebody else's tenant from
         * this transaction's platform scope is refused by the INSERT check, which is the main defence line
         * doing its job rather than a nuisance to route around.
         *
         * An unknown name is refused rather than quietly skipped: skipping would rebuild the exact silent
         * gap this closes, and leave a boot log that reads like success.
         */
        if (members.length > 0) {
          const known = await transaction
            .select({ id: users.id })
            .from(users)
            .where(inArray(users.id, members));
          const missing = members.filter(
            (id) => !known.some((row) => row.id === id),
          );
          if (missing.length > 0) {
            throw new Error(
              `Tenant package cannot add ${missing
                .map((id) => `"${id}"`)
                .join(
                  ", ",
                )} to its channels: no such user. Provision the person before synchronizing the package, or the channels will belong to nobody.`,
            );
          }
        }

        /*
         * The skills the package ships, and what each one declares it needs.
         *
         * A DEPLOYMENT SKILL, not a person's: `owner_user_id` is null, so everybody sees it in their `/`
         * menu, the same as one an administrator wrote. `origin` says where it came from, which is the
         * only thing distinguishing it from an administrator's own on the Skills page.
         *
         * The declared refs are NOT checked against `mcp_tools` here, unlike the API path, which refuses
         * a tool this deployment has never seen. A package is written before anybody connects anything,
         * so it necessarily names tools for connectors that may not be added yet — and that is the point
         * of shipping it. An unknown ref sits inert until its connector exists, because the run-time
         * intersection only ever offers what the Bot was granted.
         */
        /*
         * Which coworkers asked for each skill, so the loop below can pair them as it seeds.
         *
         * Written wholesale under one marker: every grant this package made last time is removed first,
         * so a package that stops giving a Bot a skill takes it back. Only its own, though. A grant an
         * administrator made through the Skills page carries their id and survives, because retracting
         * somebody's deliberate decision is not something a redeploy should do quietly.
         */
        const wantedBy = new Map<string, string[]>();
        for (const agent of tenantPackage.agents) {
          for (const slug of agent.skills) {
            wantedBy.set(slug, [...(wantedBy.get(slug) ?? []), agent.id]);
          }
        }
        await transaction
          .delete(pluginGrants)
          .where(
            and(
              eq(pluginGrants.kind, "skill"),
              eq(pluginGrants.grantedBy, PACKAGE_GRANT),
              inArray(
                pluginGrants.agentId,
                transaction
                  .select({ id: agentTable.id })
                  .from(agentTable)
                  .where(eq(agentTable.packageId, deploymentPackage.id)),
              ),
            ),
          );

        for (const skill of tenantPackage.skills) {
          const [seeded] = await transaction
            .insert(skillTable)
            .values({
              id: skill.slug,
              ownerUserId: null,
              slug: skill.slug,
              title: skill.title,
              summary: skill.summary,
              instructions: skill.instructions,
              origin: "catalogue",
              installedBy: null,
              // Which brand brought it in — what makes the sweep below this package's business.
              packageId: deploymentPackage.id,
            })
            .onConflictDoUpdate({
              target: skillTable.slug,
              /*
               * Only ever a package skill. The `/` namespace is shared and first to take a name keeps
               * it, so a person who wrote their own skill under this slug keeps theirs and the package
               * loses one — rather than the package silently replacing something somebody wrote.
               *
               * A collision is skipped rather than thrown, unlike the agent case above. Anybody signed
               * in may write a skill, so throwing would let one person stop the deployment booting by
               * choosing a name.
               */
              setWhere: eq(skillTable.origin, "catalogue"),
              set: {
                title: skill.title,
                summary: skill.summary,
                instructions: skill.instructions,
                // Re-stated with the rest of the identity, so a re-claim is not a row with no brand.
                packageId: deploymentPackage.id,
                updatedAt: new Date(),
              },
            })
            .returning({ id: skillTable.id });

          if (!seeded) {
            console.warn(
              JSON.stringify({
                type: "package-skill-skipped",
                slug: skill.slug,
                reason:
                  "a skill written in this deployment already answers to that name, and it keeps it",
              }),
            );
            continue;
          }

          // Replaced wholesale, so a tool the package stopped declaring stops being declared. The same
          // rule the API path applies, and the reason the table is keyed on (skill, ref).
          await transaction
            .delete(skillTools)
            .where(eq(skillTools.skillId, seeded.id));
          if (skill.tools.length > 0) {
            await transaction.insert(skillTools).values(
              skill.tools.map((ref) => ({
                skillId: seeded.id,
                ref,
                declaredBy: null,
              })),
            );
          }

          /*
           * Paired only with the skill this package actually owns.
           *
           * Inside this branch on purpose: the seed above skips a slug a person had already taken, and
           * granting there would hand the package's Bots an instruction somebody else wrote under a name
           * the package expected to be its own. Skipped, it keeps the existing warning and grants
           * nothing, which is the safe half of the same decision.
           */
          const agentIds = wantedBy.get(skill.slug) ?? [];
          if (agentIds.length > 0) {
            await transaction
              .insert(pluginGrants)
              .values(
                agentIds.map((agentId) => ({
                  kind: "skill",
                  ref: seeded.id,
                  agentId,
                  grantedBy: PACKAGE_GRANT,
                })),
              )
              .onConflictDoUpdate({
                target: [
                  pluginGrants.kind,
                  pluginGrants.ref,
                  pluginGrants.agentId,
                ],
                // An administrator who granted this by hand keeps the credit; the package only ever
                // adds what was missing, and the delete above already took back what it owned.
                set: { updatedAt: new Date() },
              });
          }
        }

        /*
         * A brand that stops shipping a skill takes back its own — and only its own (ticket 029).
         *
         * Found by reading the rendered `/resources` page after its chrome was translated: eleven
         * summaries from the brand this deployment had stopped loading were still on the page. The first
         * sweep was written the same shape as the coworkers' one, keyed on `origin = 'catalogue'`, and a
         * test that already existed vetoed it — `a redeploy takes back only grants from the package being
         * synchronized` — because a deployment can hold two brands' rows at once and skills had no way
         * to say which was whose. Migration 0074 added that way; this is what it was added for.
         *
         * Rows with a null `package_id` are left alone by construction, which is the whole point of the
         * backfill's one-vote rule: a skill nobody can attribute is kept, ghost or not, because deleting
         * another brand's content is the worse failure.
         */
        const declaredSkillSlugs = tenantPackage.skills.map(
          (skill) => skill.slug,
        );
        const retiredSkills = await transaction
          .delete(skillTable)
          .where(
            and(
              eq(skillTable.origin, "catalogue"),
              isNull(skillTable.ownerUserId),
              /*
               * Mine, or nobody's.
               *
               * The second arm is what makes this work on the rows migration 0074 could not attribute:
               * the trail from a skill back to a brand runs through the coworker it was paired with, and a
               * brand whose coworkers have since been retired leaves the skill with nothing to point at.
               * `origin` is what makes that safe — the API path writes `yours` for anything an
               * administrator or a person authors here (`plugins/store.ts`, `origin ?? "yours"`), so
               * `catalogue` means "a package brought this in", full stop.
               *
               * What would break it is a deployment loading MORE THAN ONE package into one database.
               * That is not a supported shape here -- `TENANT_PACKAGE_DIR` is one directory -- but it is
               * a thing a later fork could do, and the rival-workspace test below is the tripwire that
               * says so: it asserts another package's *attributed* skill survives, which stays true in
               * either world.
               */
              or(
                eq(skillTable.packageId, deploymentPackage.id),
                isNull(skillTable.packageId),
              ),
              declaredSkillSlugs.length > 0
                ? notInArray(skillTable.slug, declaredSkillSlugs)
                : undefined,
            ),
          )
          .returning({ slug: skillTable.slug });

        if (retiredSkills.length > 0) {
          /*
           * The pairings this package wrote, taken back with the skill. An administrator's own grant
           * survives — the same boundary as the coworkers' sweep — because retracting somebody's
           * deliberate decision is not what a redeploy should do quietly. `skill_tools` is
           * `ON DELETE CASCADE`, so the tool declarations a retired skill named go with it.
           */
          await transaction.delete(pluginGrants).where(
            and(
              eq(pluginGrants.kind, "skill"),
              eq(pluginGrants.grantedBy, PACKAGE_GRANT),
              inArray(
                pluginGrants.ref,
                retiredSkills.map((skill) => skill.slug),
              ),
            ),
          );
        }

        return { deploymentPackage, members, channels: tenantPackage.channels };
      }),
  );

  /*
   * The person's half of the channel, written in the person's own scope.
   *
   * After the transaction rather than inside it, because a membership row belongs to the tenant it
   * names -- the row carries that person's pin and their read marker -- and the INSERT check on
   * `channel_memberships` refuses the alternative outright: this transaction runs in the platform's
   * partition, and the platform does not get to decide who is in somebody's conversation. That refusal
   * is the main defence line working, not an obstacle, so the write moves to where the policy agrees.
   *
   * A person with no channels to join writes nothing, and an empty membership list is the ordinary
   * case for a deployment with several people: their channels come with their own provisioning.
   */
  for (const userId of synced.members) {
    await runAsTenant(userId, async () => {
      /*
       * This person's copies of what the brand stopped declaring.
       *
       * Their own conversations carry no package id and are untouched; only rows this package stamped
       * for this person are candidates, which is what makes the sweep safe to run in the person's own
       * scope instead of as a platform-wide delete that cannot tell two workspaces apart. The
       * membership and the thread mapping go with the channel -- both are `ON DELETE CASCADE` -- so a
       * retired conversation leaves no row that would list itself and then refuse to open.
       */
      const kept = synced.channels.map((channel) =>
        packageChannelId(userId, channel.id),
      );
      if (kept.length > 0) {
        await database
          .delete(channelTable)
          .where(
            and(
              eq(channelTable.tenantId, userId),
              eq(channelTable.packageId, synced.deploymentPackage.id),
              notInArray(channelTable.id, kept),
            ),
          );
      }

      for (const channel of synced.channels) {
        // Namespaced per person, and deterministic, so the next boot updates this row instead of
        // making a second one or colliding with the same package's channel in another workspace.
        const channelId = packageChannelId(userId, channel.id);
        const owned = await database
          .insert(channelTable)
          .values({
            id: channelId,
            tenantId: userId,
            name: channel.name,
            description: channel.description,
            allowedGroups: channel.allowedGroups,
            packageId: synced.deploymentPackage.id,
          })
          .onConflictDoUpdate({
            target: channelTable.id,
            setWhere: eq(channelTable.packageId, synced.deploymentPackage.id),
            set: {
              name: channel.name,
              description: channel.description,
              allowedGroups: channel.allowedGroups,
              updatedAt: new Date(),
            },
          })
          .returning({ id: channelTable.id });
        if (!owned[0]) {
          throw new Error(
            `Tenant package channel "${channel.id}" collides with a channel this package does not own for "${userId}"`,
          );
        }

        await database
          .delete(channelAgents)
          .where(eq(channelAgents.channelId, channelId));
        if (channel.permittedAgents.length) {
          await database.insert(channelAgents).values(
            channel.permittedAgents.map((agentId) => ({
              channelId,
              agentId,
            })),
          );
        }

        await database
          .insert(channelMemberships)
          .values({ channelId, userId, tenantId: userId })
          .onConflictDoNothing();

        /*
         * The thread this conversation's history lives in.
         *
         * Not optional decoration: the channel read path inner-joins this row, so a channel without
         * one is invisible to the very person it belongs to -- 404 on open and absent from the list,
         * which is how "the package seeded the channels" could be true while nobody saw any of them.
         * The primary key is (person, channel), so `onConflictDoNothing` keeps the first thread across
         * reboots rather than minting a new one and orphaning the history.
         */
        await database
          .insert(intelligenceChannelMappings)
          .values({
            channelId,
            userId,
            tenantId: userId,
            threadId: randomUUID(),
          })
          .onConflictDoNothing();
      }
    });
  }

  return synced.deploymentPackage;
}

export function createPackageStatusReader(
  database: Database,
): PackageStatusReader {
  return {
    active: async () => {
      const [tenantPackage] = await database
        .select()
        .from(deploymentPackages)
        .orderBy(desc(deploymentPackages.loadedAt))
        .limit(1);
      return tenantPackage
        ? {
            tenantId: tenantPackage.tenantId,
            sourcePath: tenantPackage.sourcePath,
            checksum: tenantPackage.checksum,
            loadedAt: tenantPackage.loadedAt.toISOString(),
          }
        : null;
    },
  };
}
