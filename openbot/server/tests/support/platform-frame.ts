import {
  afterAll as bunAfterAll,
  afterEach as bunAfterEach,
  beforeAll as bunBeforeAll,
  beforeEach as bunBeforeEach,
  test as bunTest,
} from "bun:test";
import { runAsTenant } from "../../src/tenant/context";

/**
 * Tests whose fixtures read and write rows directly, run in the `platform` frame (G01).
 *
 * Every statement this deployment sends needs a tenant frame, and a fixture that seeds two people's
 * rows, or reads back what a store wrote under somebody's tenant, is about no one person: it is the
 * platform's question. The code under test still switches into each person's own frame where it
 * writes their rows, so what these tests pin about the stores is unchanged; only the harness around
 * them is framed. Imported in place of `bun:test` for exactly these names.
 */
type Body = () => unknown;
const framed = (body: Body) => () => runAsTenant("platform", body);

export const test = Object.assign(
  (name: string, body: Body, timeout?: number) =>
    bunTest(name, framed(body), timeout),
  {
    each:
      <T extends readonly unknown[]>(rows: readonly T[]) =>
      (name: string, body: (...row: T) => unknown, timeout?: number) =>
        bunTest.each(rows as T[])(
          name,
          (...row: T) => runAsTenant("platform", () => body(...row)),
          timeout,
        ),
  },
);
export const beforeAll = (body: Body) => bunBeforeAll(framed(body));
export const afterAll = (body: Body) => bunAfterAll(framed(body));
export const beforeEach = (body: Body) => bunBeforeEach(framed(body));
export const afterEach = (body: Body) => bunAfterEach(framed(body));
