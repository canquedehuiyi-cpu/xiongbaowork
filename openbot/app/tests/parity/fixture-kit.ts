/**
 * The small toolkit an extra fixture file needs (tests/parity/extra/*.ts), kept apart from
 * fixtures.ts so each area of the app can add the reads its pages make in a file of its own, and
 * several people (or agents) can do that at once without writing over each other.
 */
export type Scenario = "data" | "empty";

export type FixtureResponse = {
  status: number;
  body?: unknown;
  contentType?: string;
};

export type FixtureContext = {
  method: string;
  url: URL;
  params: URLSearchParams;
  match: RegExpMatchArray;
  scenario: Scenario;
  data: boolean;
  /** The parsed JSON request body, when the runner could read one. */
  body: unknown;
};

export type FixtureRoute = [
  method: string,
  pattern: RegExp,
  handler: (context: FixtureContext) => FixtureResponse | undefined,
];

export const ok = (body: unknown): FixtureResponse => ({ status: 200, body });

/** The items in the data scenario, `[]` in the empty one. */
export const list = <T>(context: FixtureContext, items: T[]): T[] =>
  context.data ? items : [];
