/**
 * Which product this deployment is.
 *
 * `team` is OpenBot as an organization runs it. `personal` is one person on their own machine: no
 * sign-in, one shared computer, and none of the screens that govern other people. The governance
 * itself (the gateway, its policy, approvals and the audit trail) runs the same in both; the edition
 * only fixes what feeds it.
 */
import { envName } from "../../shared/env-aliases";
import type { Capability } from "./admin/capabilities";
import type { EnterpriseSettings } from "./admin/settings-store";

export type Edition = "team" | "personal";

/**
 * What the personal edition allows. Fixed: there is no screen to change it, and a row left in the
 * database by a team deployment is not read.
 *
 * Off is what needs a team or a fleet (Slack and Teams, Team Bots, a computer per Bot). Everything
 * else stays on, including the password manager, whose saved logins are only ever used after the
 * person picks one in the private sign-in form.
 *
 * Local computer access is on: folders on the person's own machine, through OpenBot Desktop. The
 * person picks each folder in the desktop's native picker, a folder is read-only, the desktop asks
 * before each write or command, every call leaves an audit row, and access ends when OpenBot stops
 * (`host-access/`, `desktop/src-tauri/src/desktop_host_access.rs`). Without the desktop there is no
 * host to reach: the folder routes refuse and Settings → Computer says it needs the desktop.
 */
export const PERSONAL_CAPABILITIES: Record<Capability, boolean> = {
  useBots: true,
  cloudBrowser: true,
  cloudNetwork: true,
  cloudComputer: true,
  localComputer: true,
  customRules: true,
  passwordManager: true,
  slackTeams: false,
  teamBots: false,
  ownerApps: true,
  isolatedComputers: false,
  proactive: true,
};

/**
 * There is one computer, so it is never stopped for sitting idle. Check-ins keep the team limit.
 * The one person picks their own model: there is nobody else to decide it for them.
 */
export const PERSONAL_ENTERPRISE_SETTINGS: EnterpriseSettings = {
  ssoRequired: false,
  actionRecording: false,
  inactiveComputerDays: 0,
  modelAllowlist: { enabled: false, models: [] },
  mcpAllowlist: { enabled: false, servers: [] },
  skillSharing: false,
  proactiveDailyRuns: 24,
  modelSelection: true,
};

let running: Edition = "team";

/**
 * Set once at startup, from the configuration. Module state rather than a parameter, because a
 * capability is resolved and refused in a dozen places across the server and every one of them has
 * to agree; a forgotten argument would quietly fall back to the team edition.
 */
export function setEdition(edition: Edition): void {
  running = edition;
}

export function currentEdition(): Edition {
  return running;
}

/** Unset or empty is `team`, so every deployment that predates the switch is unchanged. */
export function parseEdition(raw: string | undefined): Edition {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "team") return "team";
  if (value === "personal") return "personal";
  throw new Error(
    `${envName("EDITION")} is "${value}". It must be "team" or "personal", or unset for "team".`,
  );
}

/**
 * The environment switch that turns the personal edition's memory off: `XIONGBAO_PERSONAL_MEMORY=off`.
 * Anything else, or unset, leaves it on. A fallback for a person who does not want a Bot to remember
 * anything, not a setting to tune; read at each ask, so a test or a restart is all it takes.
 */
const PERSONAL_MEMORY_SWITCH = "XIONGBAO_PERSONAL_MEMORY";

/** Whether the personal edition's memory is on: it is, unless `XIONGBAO_PERSONAL_MEMORY=off`. */
export function personalMemoryEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment[PERSONAL_MEMORY_SWITCH]?.trim().toLowerCase() !== "off";
}

/**
 * Whether this edition has memory: what a person's Bots remember about them, the apps they learn it
 * from, and the background sync that reads them. Both editions have it. The personal edition used to
 * be left out (the desktop's local back end is licensed without memory), but memory is kept in
 * this product's own tables whenever that back end cannot hold it, so there was never a safety or billing
 * reason to withhold it there: it was a product choice, and it is now the other one. The one person
 * can switch it off with `XIONGBAO_PERSONAL_MEMORY=off`, and then the personal edition is what it was:
 * no screens, no routes, no tools, no sources and no place in a Bot's context.
 *
 * The edition and that switch, not the back end's memory entitlement: that answer only chooses where
 * memory is kept (the back end, or this product's own tables when it is unlicensed or
 * unreachable), and it changes while that back end starts. The browser is told the same answer
 * (`memory` in `/api/capabilities`, read by `offersMemory` in the app's `lib/deployment/queries.ts`).
 */
export function editionHasMemory(
  edition: Edition,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return edition !== "personal" || personalMemoryEnabled(environment);
}

/**
 * The name of the page where apps are turned on and set up, for a sentence the browser shows:
 * Admin's Plugins in the team edition, Connections in the personal one, which has no Plugins page.
 * The browser names the same two pages (`pluginsLabel` in the app's `lib/manage-paths.ts`).
 */
export function appsPage(): "Plugins" | "Connections" {
  return currentEdition() === "personal" ? "Connections" : "Plugins";
}

/** One app's own page, as a sentence names it: "its Plugins page", or "its page under Connections". */
export function itsAppPage(): string {
  return currentEdition() === "personal"
    ? "its page under Connections"
    : "its Plugins page";
}

/**
 * A step only an admin can take, in a sentence the browser shows. The personal edition has no
 * admin to ask: the one person takes the step, so it is said to them.
 */
export function askAdminTo(step: string): string {
  return currentEdition() === "personal"
    ? `${step.charAt(0).toUpperCase()}${step.slice(1)}`
    : `Ask an admin to ${step}`;
}

/**
 * {@link appsPage} for a sentence written in Chinese, as the fork's own sentences are: 插件页 in the
 * team edition, 连接页 in the personal one (upstream #1277).
 */
export function appsPageZh(): "插件页" | "连接页" {
  return currentEdition() === "personal" ? "连接页" : "插件页";
}

/** {@link askAdminTo} for a sentence written in Chinese: the one person is asked directly. */
export function askAdminToZh(step: string): string {
  return currentEdition() === "personal" ? `请${step}` : `请管理员${step}`;
}
