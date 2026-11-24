import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Guard: no text a person reads names Composio. A person connects their work apps through OpenBot,
 * and the company OpenBot connects through is never named on a screen, the admin's included (see
 * .claude/skills/openbot-copy).
 *
 * Read are the string literals, template text and JSX text of the app, the Recorder extension and
 * the shared modules both sides render, and the server's plugin routes and plugin store, which write every
 * sentence the plugin routes send to the browser. A template that interpolates the broker's
 * display name (`BROKERED_PROFILE[…].vendor`, `activeVendor`) counts as naming it.
 *
 * Not read: code identifiers, ids and env names (`composio-hubspot`, `COMPOSIO_API_KEY`; the check
 * is for the capitalised word), type-level strings, comments, tests, log calls, and docs/ and
 * charts/, which operators read to configure Composio by name. The broker client's own sentences
 * (server/src/plugins/composio*) are written for the operator; the routes a person calls pass them
 * through `forPerson` (server/src/plugins/routes.ts), and
 * server/tests/plugin-routes.test.ts pins that a person never reads one.
 */
const REPO = join(import.meta.dir, "..");
const WORD = /\bComposio\b/;
/** An interpolation of the broker's display name. */
const VENDOR_NAME =
  /^(BROKERED_PROFILE\[[^\]]+\]\.vendor|activeVendor|profile\.vendor|vendor)$/;

/**
 * Text that names Composio and is answered only to an administrator. Upstream counts the admin's
 * screens in (the header above); this tree's copy rule lets an admin read exact names (.claude/skills/openbot-copy, "Admin is allowed exact names"), and its brand
 * allowlist keeps third-party names an admin has to act on (app/tests/brand-leak-allowlist.json,
 * category third-party-name). Each entry is a route behind `requireAdmin` in
 * server/src/plugins/routes.ts, and must still match, so one that goes stale is removed rather than
 * kept as a hole. A person's own routes (connect, the access requests they file) get no entry.
 */
const ADMIN_ONLY: { file: string; text: string; why: string }[] = [
  {
    file: "server/src/plugins/routes.ts",
    text: "Composio would not answer with its app directory",
    why: "GET and POST /composio/apps, the admin's app directory (requireAdmin)",
  },
  {
    file: "server/src/plugins/routes.ts",
    text: "Removing this app did not finish, and neither this deployment nor Composio said why",
    why: "DELETE /servers/:id (requireAdmin)",
  },
  {
    file: "server/src/plugins/routes.ts",
    text: "部署自己的 OAuth 客户端只适用于 Composio",
    why: "PUT /composio/clients/:slug (requireAdmin)",
  },
  {
    file: "server/src/plugins/routes.ts",
    text: "is not an app Composio lists for this deployment",
    why: "POST /composio/apps (requireAdmin)",
  },
  {
    file: "server/src/plugins/routes.ts",
    text: "could not be enabled, and Composio said nothing about why",
    why: "POST /composio/apps (requireAdmin)",
  },
  {
    file: "server/src/plugins/store.ts",
    text: "resolves to a brokered credential with no Composio app in its url",
    why: "an invariant the routes show only on DELETE /servers/:id (requireAdmin); elsewhere it is a bodyless 500",
  },
  {
    file: "server/src/plugins/store.ts",
    text: "is a Composio app this deployment has enabled",
    why: "a refusal of adding or re-keying a server, done by an admin (the server routes and access-request approval)",
  },
  {
    file: "server/src/plugins/store.ts",
    text: "is the name of this deployment's own Composio screen",
    why: "a refusal of a server an admin adds by URL",
  },
  {
    file: "server/src/plugins/store.ts",
    text: "belong to the Composio apps this deployment enables",
    why: "a refusal of a server an admin adds by URL",
  },
  {
    file: "server/src/plugins/store.ts",
    text: "is not a name a Composio app can have",
    why: "POST /composio/apps, the admin enabling an app (requireAdmin)",
  },
];

const isAdminOnly = (hit: string) =>
  ADMIN_ONLY.some(
    (entry) => hit.startsWith(`${entry.file}:`) && hit.includes(entry.text),
  );

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

/** Written to a log, or part of a type or an import: never shown. */
function unshown(node: ts.Node): boolean {
  for (let at = node.parent; at && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isCallExpression(at) && LOGGING.test(at.expression.getText()))
      return true;
    if (ts.isImportDeclaration(at) || ts.isExportDeclaration(at)) return true;
    if (ts.isTypeNode(at)) return true;
  }
  return false;
}

/** Every piece of text in a TypeScript file that names Composio, as `file:line  text`. */
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
  const at = (node: ts.Node, said: string) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
    found.push(`${relative(REPO, path)}:${line + 1}  ${said.trim()}`);
  };
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
    if (said !== null && WORD.test(said) && !unshown(node)) at(node, said);
    if (
      ts.isTemplateSpan(node) &&
      VENDOR_NAME.test(node.expression.getText(file)) &&
      !unshown(node)
    )
      at(node, `\${${node.expression.getText(file)}}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function shown(): string[] {
  const found = [
    ...["app/src", "extension/src", "shared"].flatMap((root) => [
      ...files(join(REPO, root), /\.tsx?$/),
    ]),
    // This tree keeps the plugin routes and the plugin store as one file each, where upstream split
    // them into route-groups/ and plugin-store/.
    join(REPO, "server/src/plugins/routes.ts"),
    join(REPO, "server/src/plugins/store.ts"),
  ].flatMap(scriptText);
  return found;
}

test("no text a person reads in the app or the plugin routes says Composio", () => {
  expect(shown().filter((hit) => !isAdminOnly(hit))).toEqual([]);
});

test("every exception for text only an admin reads still matches", () => {
  const found = shown();
  const stale = ADMIN_ONLY.filter(
    (entry) =>
      !found.some(
        (hit) => hit.startsWith(`${entry.file}:`) && hit.includes(entry.text),
      ),
  );
  expect(stale).toEqual([]);
});

test("the scan finds what it is for", () => {
  // A scanner that finds nothing passes every tree. These are shown, so each must be caught.
  const sample = join(import.meta.dir, "fixtures", "composio-copy");
  expect(scriptText(join(sample, "shown.tsx")).length).toBe(5);
  expect(scriptText(join(sample, "logged.ts"))).toEqual([]);
});
