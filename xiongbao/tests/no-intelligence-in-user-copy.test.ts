import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Guard: no text a person reads names Intelligence. To a person it is all XiongBao, and the part of
 * XiongBao they mean is the back end (see .claude/skills/xiongbao-copy).
 *
 * Read are the string literals, template text and JSX text of the app, the server, the Recorder
 * extension and the shared Recorder disclosure.
 * Not read: code identifiers and env names (`intelligenceStack`, `INTELLIGENCE_API_URL`; the check
 * is for the capitalised word), comments, tests, log calls, and docs/ and charts/, which operators
 * read to configure Intelligence by name.
 */
const REPO = join(import.meta.dir, "..");
const WORD = /\bIntelligence\b/;

/**
 * Text that names Intelligence and never reaches a person: written only to the server's log, or
 * refused before the server serves anything. Each entry must still match, so one that goes stale
 * is removed rather than kept as a hole.
 */
const NOT_SHOWN: { file: string; text: string; why: string }[] = [
  {
    file: "server/src/config.ts",
    text: "is optional, and is half configured",
    why: "a boot refusal, printed to the operator's terminal before the server listens (Intelligence is optional in this tree, so the two refusals of a missing one are gone)",
  },
  {
    file: "server/src/index.ts",
    text: "Intelligence is not connected.",
    why: "the rejection the setup checklist reads as unreachable (intelligenceFact keeps no message) and the banner only logs",
  },
  {
    file: "server/src/recorder/trajectory-connect.ts",
    text: "Could not connect to Intelligence",
    why: "the runtime's own reply, matched for the Recorder; it reads only the code and status (extension/src/offscreen/grant.ts)",
  },
  {
    file: "server/src/config.ts",
    text: "must be the Intelligence project's numeric ID",
    why: "a boot refusal, printed before the server listens",
  },
  {
    file: "server/src/intelligence-entitlement-check.ts",
    text: "Intelligence has no valid licence. Give Intelligence's own deployment",
    why: "the boot log's advice, which names the Helm keys an operator sets",
  },
  {
    file: "server/src/intelligence-entitlement-check.ts",
    text: "Intelligence's licence has expired. Renew it and replace COPILOTKIT_LICENSE_TOKEN",
    why: "the boot log's advice",
  },
  {
    file: "server/src/intelligence-entitlement-check.ts",
    text: "Managed Intelligence could not resolve this project's entitlement",
    why: "the boot log's advice",
  },
  {
    file: "server/src/intelligence-entitlement-check.ts",
    text: "Intelligence answers that this deployment's entitlement is not active",
    why: "the boot log's advice",
  },
  {
    file: "server/src/intelligence-entitlement-check.ts",
    text: "Intelligence did not confirm this deployment's entitlement",
    why: "the boot log's advice",
  },
];

/**
 * Text that names Intelligence and is shown only to an administrator. Upstream counts every screen
 * in; this tree's copy rule lets an admin read exact names (.claude/skills/xiongbao-copy, "Admin is
 * allowed exact names"), and its brand allowlist keeps the third-party service an admin has to sign
 * up for (app/tests/brand-leak-allowlist.json, category third-party-name). Each entry must still
 * match, so one that goes stale is removed rather than kept as a hole.
 */
const ADMIN_ONLY: { file: string; text: string; why: string }[] = [
  {
    file: "app/src/routes/_authed/admin/learning.tsx",
    text: "Intelligence",
    why: "the admin Learning page (the admin route refuses anyone whose role is not admin), which configures the Intelligence project Learning runs in",
  },
  {
    file: "server/src/app.ts",
    text: "Intelligence，自动学习不可用",
    why: "/api/admin/learning/* when Intelligence is not connected, behind requireAdmin",
  },
];

/** Calls whose arguments are written to a log, never shown. */
const LOGGING =
  /^(console\.\w+|log|logger\.\w+|this\.log|options\.log|note|once|sayUnavailable)$/;

function* files(directory: string, source: RegExp): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (["node_modules", "dist", "target", "tests", "gen"].includes(name))
      continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* files(path, source);
    else if (source.test(name) && !/\.test\.tsx?$|_tests\.rs$/.test(name))
      yield path;
  }
}

function logged(node: ts.Node): boolean {
  for (let at = node.parent; at && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isCallExpression(at) && LOGGING.test(at.expression.getText()))
      return true;
    if (ts.isImportDeclaration(at) || ts.isExportDeclaration(at)) return true;
  }
  return false;
}

/** Every piece of text in a TypeScript file that names Intelligence, as `file:line  text`. */
function scriptText(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const said =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
        ? node.text
        : null;
    if (said !== null && WORD.test(said) && !logged(node)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
      found.push(`${relative(REPO, path)}:${line + 1}  ${said.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function shown(): string[] {
  const found = [
    ...["app/src", "server/src", "extension/src"].flatMap((root) => [
      ...files(join(REPO, root), /\.tsx?$/),
    ]),
    join(REPO, "shared/recorder-disclosure.ts"),
  ].flatMap(scriptText);
  return found;
}

const isNotShown = (hit: string) =>
  [...NOT_SHOWN, ...ADMIN_ONLY].some(
    (entry) => hit.startsWith(`${entry.file}:`) && hit.includes(entry.text),
  );

test("no text a person reads in the app, the server or the Recorder says Intelligence", () => {
  expect(shown().filter((hit) => !isNotShown(hit))).toEqual([]);
});

test("every exception for text that is never shown still matches", () => {
  const found = shown();
  const stale = [...NOT_SHOWN, ...ADMIN_ONLY].filter(
    (entry) =>
      !found.some(
        (hit) => hit.startsWith(`${entry.file}:`) && hit.includes(entry.text),
      ),
  );
  expect(stale).toEqual([]);
});

test("the scan finds what it is for", () => {
  // A scanner that finds nothing passes every tree. These are shown, so each must be caught.
  const sample = join(import.meta.dir, "fixtures", "intelligence-copy");
  expect(scriptText(join(sample, "shown.tsx")).length).toBe(4);
  expect(scriptText(join(sample, "logged.ts"))).toEqual([]);
});
