/**
 * What pages remember for the signed-in person in module memory — e.g. the 员工管理 wall a detail
 * page's back link returns to. Each such memory registers how to forget itself; signing out calls
 * them all, so nothing one account left behind reaches whoever signs in next in the same tab.
 */
const forgetters = new Set<() => void>();

export function rememberForSession(forget: () => void): void {
  forgetters.add(forget);
}

export function forgetSession(): void {
  for (const forget of forgetters) forget();
}
