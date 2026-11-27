/*
 * The names this product no longer goes by: the upstream project it was first built from, and the
 * third-party library that project was published under. This file is the one place that spells
 * them. The brand guard (scan.ts) fails on them anywhere else in the source, so a test that has to
 * say "this output carries none of them" imports them from here instead of writing them out.
 */

/** The acceptance search words, case-insensitive. */
export const OLD_NAME = /openbot|open-bot|open_bot|open\.bot|copilotkit/i;

/** The same, for counting or replacing every occurrence. */
export const OLD_NAMES = new RegExp(OLD_NAME.source, "gi");

/** The upstream product, as it was spelled in prose and as a lowercase identifier. */
export const OLD_PRODUCT = "OpenBot";
export const OLD_PRODUCT_LOWER = "openbot";
/** Its environment-variable prefix before v0.2.16. */
export const OLD_ENV_PREFIX = "OPENBOT_";

/** The third-party library: its name and the scope its npm packages are published under. */
export const LIBRARY = "CopilotKit";
export const LIBRARY_LOWER = "copilotkit";
export const LIBRARY_SCOPE = "@copilotkit/";
