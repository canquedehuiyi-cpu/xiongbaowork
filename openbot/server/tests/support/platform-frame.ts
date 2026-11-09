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
/** What bun's `test` and hooks take: a body whose result, if any, is a promise to wait for. */
const framed =
  (body: Body) =>
  async (): Promise<void> => {
    await runAsTenant("platform", body);
  };
/**
 * One row's arguments, the way `bun:test`'s `each` hands them over: an array row is spread into the
 * body's parameters, anything else is its one argument.
 */
type Row<T> = [T] extends [readonly unknown[]] ? [...T] : [T];

export const test = Object.assign(
  (name: string, body: Body, timeout?: number) =>
    bunTest(name, framed(body), timeout),
  {
    each:
      <const T>(rows: readonly T[]) =>
      (name: string, body: (...row: Row<T>) => unknown, timeout?: number) =>
        bunTest.each(rows as unknown[])(
          name,
          async (...row: unknown[]) => {
            await runAsTenant("platform", () => body(...(row as Row<T>)));
          },
          timeout,
        ),
  },
);
export const beforeAll = (body: Body) => bunBeforeAll(framed(body));
export const afterAll = (body: Body) => bunAfterAll(framed(body));
export const beforeEach = (body: Body) => bunBeforeEach(framed(body));
export const afterEach = (body: Body) => bunAfterEach(framed(body));
