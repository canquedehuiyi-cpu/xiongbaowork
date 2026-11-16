import { expect, test } from "bun:test";
import { Glob } from "bun";
import ts from "typescript";

/**
 * Every `<form onSubmit>` has something that submits it.
 *
 * Base UI's `Button` renders `type="button"` unless told otherwise, so a `<Button>` that looks like
 * a form's submit does nothing when pressed, and the form's own tests still pass because they fire
 * `submit` on the form directly. That shipped four dead forms at once (Remember, Add and sync
 * source, Confirm phone, Turn on background research) and the recorder before them. A plain
 * `<button>` defaults to submit, so it counts; a `<Button>` counts only with `type="submit"`.
 *
 * A submit control outside the form that names it with `form={…}` (a dialog's footer, so the
 * dialog body keeps scrolling) submits it as surely as one inside, so it counts when the same file
 * gives the form that `id`.
 *
 * A form submitted some other way (the composer's Enter key and send action) names itself here with
 * a reason, rather than every form losing the check.
 */
const SUBMITTED_ELSEWHERE = new Set([
  // Enter submits through the editor, and the send action is its own typed control.
  "src/components/channels/composer/composer.tsx",
  // The step's form is submitted by the onboarding frame's primary button (`primaryForm`), which
  // `onboarding-frame.tsx` draws with `form={primary.form}` and `type="submit"`.
  "src/components/onboarding/name-step.tsx",
  // An address bar: one field, submitted by Enter in it; the buttons beside it move back and forth.
  "src/components/browser/browser-bar.tsx",
  // The new tab's one search field, submitted by Enter in it as a browser's start page is.
  "src/components/browser/browser-screen.tsx",
]);

function attribute(node: ts.JsxOpeningLikeElement, name: string) {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function submits(node: ts.JsxOpeningLikeElement): boolean {
  const tag = node.tagName.getText();
  const type = attribute(node, "type")?.initializer;
  const typeText =
    type && ts.isStringLiteral(type)
      ? type.text
      : type && ts.isJsxExpression(type) && type.expression
        ? type.expression.getText().replace(/["'`]/g, "")
        : undefined;
  if (tag === "button") return typeText === undefined || typeText === "submit";
  if (tag === "input") return typeText === "submit";
  return typeText === "submit";
}

test("every form with an onSubmit has a control that submits it", async () => {
  const dead: string[] = [];
  for await (const file of new Glob("src/**/*.tsx").scan(
    `${import.meta.dir}/..`,
  )) {
    if (SUBMITTED_ELSEWHERE.has(file)) continue;
    const text = await Bun.file(`${import.meta.dir}/../${file}`).text();
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    /*
     * JSX held in a same-file const is still inside the form that spreads it. The sign page builds its
     * address-and-password block once and drops it into two forms; a scan that only reads the form's own
     * subtree would call those forms dead while a real submit button sits in the fields.
     */
    const fragments = new Map<string, ts.Node>();
    const collect = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        containsJsx(node.initializer)
      ) {
        fragments.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    /** The `form={…}` of every submit control in this file, as written, for a form that names its `id`. */
    const submittersByForm = new Set<string>();
    const findSubmitters = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        submits(node)
      ) {
        const form = attributeText(attribute(node, "form"));
        if (form !== undefined) submittersByForm.add(form);
      }
      ts.forEachChild(node, findSubmitters);
    };
    findSubmitters(source);
    const visit = (node: ts.Node) => {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText() === "form" &&
        attribute(node.openingElement, "onSubmit")
      ) {
        const id = attributeText(attribute(node.openingElement, "id"));
        let found = id !== undefined && submittersByForm.has(id);
        const inside = (child: ts.Node, seen: Set<string>) => {
          if (found) return;
          if (
            (ts.isJsxOpeningElement(child) ||
              ts.isJsxSelfClosingElement(child)) &&
            submits(child)
          )
            found = true;
          if (
            ts.isJsxExpression(child) &&
            child.expression &&
            ts.isIdentifier(child.expression)
          ) {
            const name = child.expression.text;
            const fragment = fragments.get(name);
            if (fragment && !seen.has(name)) {
              seen.add(name);
              ts.forEachChild(fragment, (node) => inside(node, seen));
              seen.delete(name);
            }
          }
          ts.forEachChild(child, (node) => inside(node, seen));
        };
        ts.forEachChild(node, (child) => inside(child, new Set()));
        if (!found) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          dead.push(`${file}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(dead).toEqual([]);
  /*
   * Its own deadline, not bun's default five seconds. This parses every `.tsx` under `src` and costs
   * ~4.4 s alone on the dev image, so in a full single-process run it crossed five seconds the day one
   * more screen was added and failed as a timeout -- reading as a dead form when every form was fine.
   * The cost grows with the codebase; the guard's answer does not depend on how long it takes.
   */
}, 30_000);

/** An attribute's value as written: a string literal's text, or the expression's source. */
function attributeText(
  attribute: ts.JsxAttribute | undefined,
): string | undefined {
  const value = attribute?.initializer;
  if (!value) return undefined;
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isJsxExpression(value) && value.expression)
    return value.expression.getText();
  return undefined;
}

function containsJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) return true;
  if (ts.isJsxFragment(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsJsx(child)) found = true;
  });
  return found;
}
