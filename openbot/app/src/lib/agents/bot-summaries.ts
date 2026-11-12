import { shortName } from "@/lib/brand";
/**
 * The current answer each "Settings for this Bot" row states, computed from its query on every
 * render so it updates itself when the page behind it changes something.
 *
 * 熊宝：界面文案是中文。`countLabel` 的签名照上游保留（一个、多个、没有三种说法），中文没有单复数，调用方
 * 给同一个量词即可，例如 `countLabel(n, "个技能", "个技能", "没有技能")` → 「2 个技能」。
 */

export function countLabel(
  count: number,
  one: string,
  many: string,
  none: string,
): string {
  if (count === 0) return none;
  return `${count} ${count === 1 ? one : many}`;
}

export function accessSummary(skills: number, apps: number): string {
  const parts = [
    skills ? countLabel(skills, "个技能", "个技能", "") : "",
    apps ? countLabel(apps, "个应用", "个应用", "") : "",
  ].filter(Boolean);
  return parts.length ? parts.join("、") : "还没有授予任何技能或应用";
}

/**
 * Who else can use it. Publishing and visibility are separate records: a public Bot nobody published
 * is still open to everyone in the deployment.
 */
export function sharingSummary(
  published: { audience: "team" | "people" } | undefined,
  visibility: "public" | "private",
): string {
  if (!published) {
    return visibility === "public" ? "所有人（公开）" : "未共享";
  }
  return published.audience === "team" ? "整个团队" : "指定的人和分组";
}

/**
 * Where it runs. The personal edition names what runs it when OpenBot knows: its one person
 * picked that harness at setup, and the address is the container OpenBot started for it, which
 * means nothing to them. A team deployment shows the address, which an admin or owner gave it.
 */
export function setupSummary(
  agent: {
    builtIn: boolean;
    endpoint: string | null;
    framework?: string;
  },
  edition: "team" | "personal" = "team",
): string {
  if (agent.builtIn || !agent.endpoint) return "内置";
  if (edition === "personal" && agent.framework)
    return `运行在 ${agent.framework} 上`;
  try {
    return new URL(agent.endpoint).host;
  } catch {
    return agent.endpoint;
  }
}

const TRANSPORT_LABEL: Record<string, string> = {
  slack: "Slack",
  teams: "Microsoft Teams",
  sms: "短信",
};

/** Where this Bot's conversations continue outside 熊宝, each place once. */
export function reachSummary(transports: readonly string[]): string {
  const places = [...new Set(transports)]
    .map((transport) => TRANSPORT_LABEL[transport] ?? transport)
    .sort((a, b) => a.localeCompare(b));
  return places.length ? places.join("、") : `只在${shortName()}里`;
}

/** The apps feeding this Bot facts, and whether it checks in on them. */
export function memorySummary(sources: number, research: boolean): string {
  const parts = [
    sources ? countLabel(sources, "个信息源", "个信息源", "") : "",
    research ? "巡检已开" : "",
  ].filter(Boolean);
  return parts.length ? parts.join("、") : "还没接入信息源";
}
