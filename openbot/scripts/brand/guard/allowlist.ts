/*
 * What the brand allowlist records about each entry: why the old name is still there (category),
 * what is to happen to it (plan), and for a compatibility alias, the release window it lives in.
 */

export const CATEGORIES = [
  "legacy-compat",
  "persisted-data",
  "crypto-domain",
  "peer-protocol",
  "parsed-exact-text",
  "operator-visible",
  "third-party-name",
  "upstream-shell-only",
  "developer-only",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Plan = "keep" | "rewrite" | "remove";

export const PLANS: Record<Category, Plan[]> = {
  "legacy-compat": ["remove"],
  "persisted-data": ["keep", "rewrite"],
  "crypto-domain": ["keep"],
  "peer-protocol": ["keep", "rewrite"],
  "parsed-exact-text": ["keep", "rewrite"],
  "operator-visible": ["rewrite"],
  "third-party-name": ["keep"],
  "upstream-shell-only": ["keep"],
  "developer-only": ["keep"],
};

export type AllowEntry = {
  file: string;
  text: string;
  reason: string;
  category: Category;
  plan: Plan;
  introducedIn?: string;
  removeIn?: string;
  notBefore?: string;
  device?: true;
};

const VERSION = /^\d+\.\d+\.\d+$/;

export function entryProblems(entry: AllowEntry): string[] {
  const where = `${entry.file}: ${entry.text}`;
  const problems: string[] = [];
  const allowed = PLANS[entry.category];
  if (!allowed) {
    problems.push(
      `${where}: category "${entry.category}" is not one of the known categories`,
    );
    return problems;
  }
  if (!allowed.includes(entry.plan))
    problems.push(
      `${where}: plan "${entry.plan}" is not allowed for ${entry.category} (${allowed.join(" | ")})`,
    );
  if (entry.category === "legacy-compat") {
    for (const key of ["introducedIn", "removeIn"] as const)
      if (!entry[key]) problems.push(`${where}: legacy-compat needs ${key}`);
  }
  for (const key of ["introducedIn", "removeIn", "notBefore"] as const) {
    const value = entry[key];
    if (value !== undefined && !VERSION.test(value))
      problems.push(
        `${where}: ${key} "${value}" is not a version of the form X.Y.Z`,
      );
  }
  if (
    (entry.category === "persisted-data" ||
      entry.category === "peer-protocol") &&
    entry.plan === "rewrite" &&
    !/\bL1-\d+/.test(entry.reason)
  )
    problems.push(
      `${where}: a rewrite plan must name its L1- number in reason`,
    );
  return problems;
}

const compare = (a: string, b: string): number => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** Formal releases newer than `version`: the changelog's `## X.Y.Z` headings plus `current`. */
export function releasesAfter(
  version: string,
  changelog: string,
  current: string,
): string[] {
  const released = new Set<string>([current]);
  for (const match of changelog.matchAll(/^##\s+v?(\d+\.\d+\.\d+)(?=\s|$)/gm))
    released.add(match[1] as string);
  return [...released]
    .filter((candidate) => compare(candidate, version) > 0)
    .sort(compare);
}

export function isExpired(
  entry: AllowEntry,
  changelog: string,
  current: string,
): boolean {
  if (entry.category !== "legacy-compat" || !entry.introducedIn) return false;
  if (releasesAfter(entry.introducedIn, changelog, current).length < 2)
    return false;
  return !entry.notBefore || compare(current, entry.notBefore) >= 0;
}
