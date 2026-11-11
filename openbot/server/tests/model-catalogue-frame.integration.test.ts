import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import ts from "typescript";
import {
  createCredentialStore,
  resolveModelApiKey,
  sealCredential,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials } from "../src/db/schema";
import {
  createModelCatalogue,
  reportModelRejected,
} from "../src/model-catalogue";
import {
  isTenantFramed,
  runAsTenant,
  tenantFrame,
} from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The model list's background reads of the deployment's own key (G01).
 *
 * The catalogue reads its listing at boot, again on a timer, and early when a provider refuses a
 * model. None of those has a person behind it, so none runs in a tenant frame, and the deployment's
 * key lives in the credential vault, which refuses every read outside one. Wired with the bare
 * resolver, each background read logged `model-list-unreadable … TenantContextError` and the list
 * was only brought up to date when somebody opened the picker or sent a message, whose request frame
 * the read borrowed.
 *
 * `index.ts` cannot be imported (it starts the server at the top level), so the wire is read off its
 * syntax tree below, and the behaviour is driven here through the same shape against a real vault
 * under row security.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = Buffer.alloc(32, 29).toString("base64");
const store = createCredentialStore(database);
const KEY = "sk-deployment-not-a-real-key-0123456789";
const LISTING = "https://api.openai.com/v1/models";
const seeded: string[] = [];

afterAll(async () => {
  for (const id of seeded)
    await runAsTenant("system", () =>
      database.delete(credentials).where(eq(credentials.id, id)),
    );
  await database.$client.close();
});

/** The deployment's own key, as a `system` row under a name only this test uses. */
async function deploymentKey(): Promise<string> {
  const keyId = `catalogue-frame-${randomUUID()}`;
  const id = randomUUID();
  seeded.push(id);
  await runAsTenant("system", async () =>
    database.insert(credentials).values({
      id,
      kind: "model",
      provider: "openai",
      keyId,
      encryptedValue: await sealCredential(
        encryptionKey,
        { tenantId: "system", id, kind: "model" },
        KEY,
      ),
      metadata: {},
    }),
  );
  return keyId;
}

/** `resolveRuntimeModelApiKey` in `index.ts`: the vault first, no environment key to fall back on. */
const resolverFor = (keyId: string) => () =>
  resolveModelApiKey({
    encryptionKey,
    reader: store,
    provider: "openai",
    keyId,
    environment: {},
  });

/**
 * The wire `index.ts` gives the catalogue: a call made in a frame keeps it, and one made in none
 * reads as `platform`, the frame the boot model check already reads the same key in.
 */
const asTheCatalogueReads =
  (resolve: () => Promise<string | null>) => (): Promise<string | null> =>
    isTenantFramed() ? resolve() : runAsTenant("platform", resolve);

/** OpenAI's listing, recording which key each ask carried and which frame the ask came from. */
function openAI() {
  const asks: {
    authorization: string | undefined;
    frame: string | undefined;
  }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(LISTING);
    asks.push({
      authorization: (init?.headers as Record<string, string> | undefined)
        ?.authorization,
      frame: tenantFrame(),
    });
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ id: "gpt-5.5", object: "model", created: 1 }],
      }),
    );
  }) as typeof fetch;
  return { fetcher, asks };
}

function catalogueFor(
  apiKey: () => Promise<string | null>,
  refreshMs?: number,
) {
  const site = openAI();
  const logged: string[] = [];
  const catalogue = createModelCatalogue({
    model: { provider: "openai", defaultModel: "gpt-5.5" },
    apiKey,
    environment: {},
    fetch: site.fetcher,
    log: (line) => logged.push(line),
    capabilitiesUrl: null,
    ...(refreshMs === undefined ? {} : { refreshMs }),
  });
  return { catalogue, site, logged };
}

async function until(done: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

describe("the model list read in the background", () => {
  test("an unframed read of the vault is the TenantContextError the start-up log showed", async () => {
    const keyId = await deploymentKey();
    const { catalogue, site, logged } = catalogueFor(resolverFor(keyId));
    expect(tenantFrame()).toBeUndefined();
    await catalogue.refresh();
    expect(site.asks).toEqual([]);
    expect(logged.map((line) => JSON.parse(line))).toEqual([
      {
        type: "model-list-unreadable",
        source: catalogue.source,
        reason: "TenantContextError",
      },
    ]);
  });

  test("start, the timer and an early refresh each read the deployment's key as platform", async () => {
    const keyId = await deploymentKey();
    const { catalogue, site, logged } = catalogueFor(
      asTheCatalogueReads(resolverFor(keyId)),
      40,
    );
    expect(tenantFrame()).toBeUndefined();
    const stop = catalogue.start();
    try {
      // The read `start` begins at once.
      await until(() => site.asks.length >= 1);
      // Then the timer's.
      await until(() => site.asks.length >= 2);
    } finally {
      stop();
    }
    // A provider refusing a model, with no frame around the report, outside the timer.
    const {
      catalogue: early,
      site: earlySite,
      logged: earlyLogged,
    } = catalogueFor(asTheCatalogueReads(resolverFor(keyId)));
    const unsubscribe = early.start();
    try {
      await until(() => earlySite.asks.length >= 1);
      reportModelRejected();
      await until(() => earlySite.asks.length >= 2);
    } finally {
      unsubscribe();
    }

    const asks = [...site.asks, ...earlySite.asks];
    expect(asks.map((ask) => ask.authorization)).toEqual(
      asks.map(() => `Bearer ${KEY}`),
    );
    // The frame is the key read's alone: the listing itself is asked from none.
    expect(asks.filter((ask) => ask.frame !== undefined)).toEqual([]);
    // Nothing unreadable: the only line is the early refresh announcing itself.
    expect(logged).toEqual([]);
    expect(earlyLogged.map((line) => JSON.parse(line))).toEqual([
      { type: "model-list-refresh-early", source: early.source },
    ]);
    expect((await catalogue.read()).models.map((model) => model.id)).toContain(
      "gpt-5.5",
    );
  });

  test("a read made in a person's frame keeps that frame and still gets the deployment's key", async () => {
    const keyId = await deploymentKey();
    const frames: (string | undefined)[] = [];
    const resolve = resolverFor(keyId);
    const { catalogue, site, logged } = catalogueFor(
      asTheCatalogueReads(() => {
        frames.push(tenantFrame());
        return resolve();
      }),
    );
    const person = `catalogue-person-${randomUUID().slice(0, 8)}`;
    await runAsTenant(person, () => catalogue.refresh());
    expect(frames).toEqual([person]);
    expect(site.asks.map((ask) => ask.authorization)).toEqual([
      `Bearer ${KEY}`,
    ]);
    expect(logged).toEqual([]);
  });
});

/*
 * The wire itself, in `index.ts`. Parsed rather than matched as text, so a reformatted line reads
 * the same and a comment naming the call does not count.
 */
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const index = ts.createSourceFile(
  INDEX,
  readFileSync(INDEX, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function find<T extends ts.Node>(
  root: ts.Node,
  matches: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (matches(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

const calls = (name: string) =>
  find(
    index,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name,
  );

const declaration = (name: string) => {
  const [found] = find(
    index,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name,
  );
  if (!found?.initializer) throw new Error(`${name} is not declared`);
  return found.initializer;
};

/** A call's callee, when it is a plain name. */
const callee = (node: ts.Node | undefined) =>
  node && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    ? node.expression.text
    : undefined;

describe("the catalogue's key in index.ts", () => {
  test("is read in the caller's frame, or as platform through the boot model check's own door", () => {
    const [created] = calls("createModelCatalogue");
    if (!created) throw new Error("createModelCatalogue is not called");
    const [options] = created.arguments;
    if (!options || !ts.isObjectLiteralExpression(options))
      throw new Error("createModelCatalogue takes no options literal");
    const apiKey = options.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "apiKey",
    )?.initializer;
    if (!apiKey) throw new Error("createModelCatalogue is given no apiKey");

    // `() => isTenantFramed() ? resolve() : door(resolve)`
    expect(ts.isArrowFunction(apiKey)).toBe(true);
    const body = ts.isArrowFunction(apiKey) ? apiKey.body : undefined;
    if (!body || !ts.isConditionalExpression(body))
      throw new Error(`apiKey is ${apiKey.getText()}`);
    expect(callee(body.condition)).toBe("isTenantFramed");
    expect(callee(body.whenTrue)).toBe("resolveRuntimeModelApiKey");
    const door = callee(body.whenFalse);
    expect(
      ts.isCallExpression(body.whenFalse) &&
        body.whenFalse.arguments.map((argument) => argument.getText()),
    ).toEqual(["resolveRuntimeModelApiKey"]);

    // The same door the boot model check reads the same key through, and it opens `platform`.
    const boot = declaration("modelCheckAtBoot");
    // `door(async () => …).catch(() => undefined)`: the door is the call `.catch` is made on.
    const checked =
      ts.isCallExpression(boot) &&
      ts.isPropertyAccessExpression(boot.expression) &&
      boot.expression.name.text === "catch"
        ? boot.expression.expression
        : boot;
    expect(callee(checked)).toBe(door);
    const opened = declaration(String(door));
    expect(
      ts.isArrowFunction(opened) &&
        ts.isCallExpression(opened.body) &&
        callee(opened.body),
    ).toBe("asPlatform");
  });
});
