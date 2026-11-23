import type { BaseEvent } from "@ag-ui/client";
import {
  TURN_ARTIFACTS_EVENT,
  type TurnArtifactsValue,
} from "../../../shared/turn-artifacts";
import type { AgentActor } from "../agents/profile-types";
import { workspaceFilePathOf } from "../tasks/evidence-gate";
import {
  type ComputerSeat,
  computerKeyText,
  parseComputerKey,
} from "./computer-key";

/**
 * Who may download which file from an employee's workspace, when the asker is not the person whose
 * computer the employee works on.
 *
 * WHY. The download route answers for the person asking: their own seat of the employee, behind
 * "may this person use this employee". A member of a group chat did not start the employee's turn,
 * so their seat holds none of the files the turn made, and being allowed to use the employee says
 * nothing about being allowed to read a particular file off the owner's computer.
 *
 * So a download may name where the file was announced: a conversation and one run of it
 * (`channel` + `run`), or a delivery card (`task`). The file is reachable only when (1) the asker
 * can see that conversation or card, and (2) the server itself recorded that file there: listed in
 * the run's turn artifacts, delivered on the run, or on the card's delivered files. The seat the
 * file is read from is the one the server recorded with it, never one worked out from the asker.
 *
 * A RECORD IS NOT TRUSTED FOR ITS SEAT. The seat a record names must be the one this employee runs on
 * for the person the run (or card) belongs to, as the server itself works it out (`seatFor`), and
 * the employee must still exist. A record that names anyone else's computer, however it got
 * into the run, opens nothing. (Run streams also drop a forged turn-artifacts event before it is
 * stored: `threads/run-side-events.ts`.)
 *
 * REFUSAL IS THE ONLY OTHER ANSWER. Every rule that does not hold gives `null`, and the route
 * answers that exactly as it answers "there is no such employee", so the answer cannot be used to
 * learn which conversations, runs, cards or files exist.
 */

/**
 * A running program a delivery lists: the loopback port on the employee's computer, the path to land
 * on, and the name shown to people. The delivery event `delivery.delivered` and a card's deliverable
 * carry them as `apps`.
 */
export type DeliveredApp = { port: number; path: string; title: string };

/**
 * The apps a stored value lists: only well-formed ones (a usable port, a string path and title).
 *
 * `unverifiedApps` on the same deliverable is deliberately not read: it only says the gate could not
 * request the first page (a device seat cannot be reached from the server), and `forwardHttp` cannot
 * reach that seat either, so it changes nothing about whether the program may be opened.
 */
export function deliveredAppsOf(value: unknown): DeliveredApp[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): DeliveredApp[] =>
    isRecord(item) &&
    typeof item.port === "number" &&
    Number.isInteger(item.port) &&
    item.port >= 1024 &&
    item.port <= 65535 &&
    typeof item.path === "string" &&
    typeof item.title === "string"
      ? [{ port: item.port, path: item.path, title: item.title }]
      : [],
  );
}

/** The query parameters that scope a download, under the names they have in the URL. */
export type ArtifactScope = { channel?: string; run?: string; task?: string };

/**
 * The scope a download's URL carries, or null when it carries none of the three names.
 *
 * Present is present: `?channel=` with nothing after it, or `?run=x` with no channel, is a scope,
 * and is refused by the rules rather than treated as no scope at all. A name given twice is
 * ambiguous and is read as empty, which the rules refuse.
 */
export function artifactScopeOf(url: string): ArtifactScope | null {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const scope: ArtifactScope = {};
  let named = false;
  for (const key of ["channel", "run", "task"] as const) {
    if (!params.has(key)) continue;
    named = true;
    const values = params.getAll(key);
    scope[key] = values.length === 1 ? (values[0] ?? "") : "";
  }
  return named ? scope : null;
}

/** What the rules ask of the rest of the server. Each answers in the asker's own view. */
export type ArtifactAccessDeps = {
  /**
   * The conversation as this person may see it: null when they cannot (not a member, or it is gone),
   * else the employees in it and every thread it has had (each member's own, and a group's per-owner
   * threads).
   */
  channelFor(
    actor: AgentActor,
    channelId: string,
  ): Promise<{ agentIds: string[]; threadIds: string[] } | null>;
  /**
   * One run of that conversation: the thread it ran on and its stored events in order. Null when
   * there is no such run among the conversation's threads. The conversation travels with the
   * question because the run's rows belong to whoever started it, and are only read here as part of
   * a conversation the asker was already shown to be in.
   */
  runOf(
    actor: AgentActor,
    channelId: string,
    runId: string,
  ): Promise<{
    threadId: string;
    /** Whose run it is: the person the thread belongs to, whose computer the turn used. */
    ownerId: string;
    /** The employee the run was made by: a run only speaks for the employee that ran it. */
    agentId: string;
    events: BaseEvent[];
  } | null>;
  /**
   * The delivery card as this person sees it: null when it is not theirs to see, else the employee
   * in charge, the computer seat (as text) its files were made on, and the files it lists.
   */
  cardFor(
    actor: AgentActor,
    taskId: string,
  ): Promise<{
    botId: string;
    /** Whose card it is. */
    ownerId: string;
    seat: string;
    workspaceFiles: string[];
    /** The running programs the card lists (port and landing path); absent when it lists none. */
    apps?: DeliveredApp[];
  } | null>;
  /** The seat this employee runs on for this person: the one every turn of theirs used. */
  seatFor(botId: string, personId: string): Promise<ComputerSeat>;
  /** Whether the employee still exists for that person (not deleted). */
  botIsLive(personId: string, botId: string): Promise<boolean>;
};

/**
 * The workspace-relative path a download names, or null for one that is empty, absolute, a home
 * path, a drive path or leaves the workspace. The reading the delivery card gives a file it lists.
 */
export function normalizedArtifactPath(path: string): string | null {
  return workspaceFilePathOf(path) ?? null;
}

const seatOf = (botId: string, text: unknown): ComputerSeat | null => {
  const key = parseComputerKey(text);
  return key ? { botId, key } : null;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const DELIVERED_EVENT = "delivery.delivered";

/**
 * The run's events of one name, as their values. They are the server's own by the time they are
 * stored: an agent's stream cannot carry `computer.turn_artifacts` or `delivery.*` into a run
 * (`isServerOnlyEvent`), and this still checks the seat each one names (`seatFor` below).
 */
function valuesOf(events: BaseEvent[], name: string): unknown[] {
  const found: unknown[] = [];
  for (const event of events) {
    const item: unknown = event;
    if (!isRecord(item) || item.type !== "CUSTOM" || item.name !== name)
      continue;
    found.push(item.value);
  }
  return found;
}

/** Which of the paths a run or card lists count as the one asked for. */
type PathMatch = (listed: string) => boolean;

/** What a request is for: files or a folder by path, or a running program by port. */
type Wanted = { files: PathMatch } | { appPort: number };

function viaRun(
  events: BaseEvent[],
  botId: string,
  wanted: Wanted,
  /** The seat this employee runs on for the run's owner; what a program is read from when no turn named one. */
  ownSeat: ComputerSeat | null,
): ComputerSeat | null {
  const matches: PathMatch = "files" in wanted ? wanted.files : () => false;
  // Every announcement of this employee in the run, with the seat it was made on.
  const announced: { seat: string; files: string[] }[] = [];
  for (const value of valuesOf(events, TURN_ARTIFACTS_EVENT)) {
    if (!isRecord(value)) continue;
    const turn = value as Partial<TurnArtifactsValue>;
    if (turn.botId !== botId || typeof turn.seat !== "string") continue;
    const files = Array.isArray(turn.files)
      ? turn.files.flatMap((file) =>
          isRecord(file) && typeof file.path === "string" ? [file.path] : [],
        )
      : [];
    announced.push({ seat: turn.seat, files });
  }

  // Listed in a turn's artifacts: the seat of the announcement that lists it.
  const listing = announced.find((turn) => turn.files.some(matches));
  if (listing) return seatOf(botId, listing.seat);

  // Delivered on the run: the delivery event carries no seat, so it is the seat the same run
  // announced for this employee. One computer or none; two different ones are ambiguous.
  const delivered = valuesOf(events, DELIVERED_EVENT).some((value) => {
    // Another employee's hand-in in the same run says nothing about this one's computer or ports. An
    // event written before hand-ins carried `agentId` has none: it is taken as this employee's, because
    // the caller has already required the run itself to be this employee's.
    if (!isRecord(value)) return false;
    if (value.agentId !== undefined && value.agentId !== botId) return false;
    const deliverable = isRecord(value.deliverable)
      ? value.deliverable.workspaceFiles
      : undefined;
    if ("appPort" in wanted) {
      const listed = isRecord(value.deliverable)
        ? value.deliverable.apps
        : undefined;
      return [...deliveredAppsOf(listed), ...deliveredAppsOf(value.apps)].some(
        (app) => app.port === wanted.appPort,
      );
    }
    return (
      strings(deliverable).some(matches) ||
      strings(value.workspaceFiles).some(matches)
    );
  });
  if (!delivered) return null;
  const seats = new Set(announced.map((turn) => turn.seat));
  // A run that only delivered a program changed no file, so no turn announced a seat; the seat is
  // then the owner's own, which the caller checks against the same resolver as for any other seat.
  if (seats.size === 0 && "appPort" in wanted) return ownSeat;
  if (seats.size !== 1) return null;
  return seatOf(botId, [...seats][0]);
}

/**
 * The seat to read `path` of `botId` from for this asker, or null.
 *
 * Only for a request that carries a scope; one without is the person's own employee and goes the
 * ordinary way. A scope that is present but incomplete is refused here and never read as "no scope".
 */
export async function resolveArtifactAccess(
  input: {
    actor: AgentActor;
    botId: string;
    path: string;
    scope: ArtifactScope;
  },
  deps: ArtifactAccessDeps,
): Promise<{ seat: ComputerSeat } | null> {
  const { actor, botId, scope } = input;
  const path = normalizedArtifactPath(input.path);
  if (path === null || botId === "") return null;
  const seat = await seatFor(
    actor,
    botId,
    { files: (listed) => listed === path },
    scope,
    deps,
  );
  return seat ? { seat } : null;
}

/**
 * The seat to read a folder of `botId` from for this asker, or null: the rules of
 * {@link resolveArtifactAccess}, asked of a folder instead of one file.
 *
 * The folder is reachable when the conversation's run (or the card) listed `<dir>/index.html`, or a
 * file whose DIRECT parent is `dir`. A file deeper down does not open its ancestors: a run that wrote
 * `work/p1/out.md` announced `work/p1`, not `work`, which may hold other projects. `dir` is the same
 * safe relative path the downloads take (never empty, never leaving the workspace). Whether the
 * folder exists and has an `index.html` is the caller's question to the computer, not a thing a
 * record can answer.
 */
export async function resolveArtifactDirAccess(
  input: {
    actor: AgentActor;
    botId: string;
    dir: string;
    scope: ArtifactScope;
  },
  deps: ArtifactAccessDeps,
): Promise<{ seat: ComputerSeat } | null> {
  const { actor, botId, scope } = input;
  const dir = normalizedArtifactPath(input.dir);
  if (dir === null || botId === "") return null;
  const seat = await seatFor(
    actor,
    botId,
    {
      files: (listed) => {
        const named = normalizedArtifactPath(listed);
        if (named === null) return false;
        const slash = named.lastIndexOf("/");
        return slash > 0 && named.slice(0, slash) === dir;
      },
    },
    scope,
    deps,
  );
  return seat ? { seat } : null;
}

/**
 * The seat to forward to the program on `port` of `botId` from, for this asker, or null: the rules of
 * {@link resolveArtifactDirAccess}, asked of a running program. It is reachable only when the run's
 * `delivery.delivered` event, or the card's deliverable, lists an app with that port (`apps`, see
 * {@link DeliveredApp}). Whether anything is listening there is the computer's own question.
 */
export async function resolveArtifactAppAccess(
  input: {
    actor: AgentActor;
    botId: string;
    port: number;
    scope: ArtifactScope;
  },
  deps: ArtifactAccessDeps,
): Promise<{ seat: ComputerSeat } | null> {
  if (input.botId === "" || !Number.isInteger(input.port)) return null;
  const seat = await seatFor(
    input.actor,
    input.botId,
    { appPort: input.port },
    input.scope,
    deps,
  );
  return seat ? { seat } : null;
}

async function seatFor(
  actor: AgentActor,
  botId: string,
  wanted: Wanted,
  scope: ArtifactScope,
  deps: ArtifactAccessDeps,
): Promise<ComputerSeat | null> {
  const { channel, run, task } = scope;
  const confirmed = async (
    seat: ComputerSeat | null,
    ownerId: string,
  ): Promise<ComputerSeat | null> => {
    if (!seat || ownerId === "") return null;
    const expected = await deps.seatFor(botId, ownerId);
    if (computerKeyText(expected.key) !== computerKeyText(seat.key))
      return null;
    return (await deps.botIsLive(ownerId, botId)) ? expected : null;
  };

  if (task !== undefined) {
    // One kind of scope at a time.
    if (channel !== undefined || run !== undefined || task === "") return null;
    const card = await deps.cardFor(actor, task);
    if (!card || card.botId !== botId) return null;
    const listed =
      "appPort" in wanted
        ? (card.apps ?? []).some((app) => app.port === wanted.appPort)
        : strings(card.workspaceFiles).some(wanted.files);
    if (!listed) return null;
    if ("appPort" in wanted) {
      // A card with a program and no file may carry no seat of its own.
      const named = seatOf(botId, card.seat);
      return confirmed(
        named ?? (await deps.seatFor(botId, card.ownerId)),
        card.ownerId,
      );
    }
    return confirmed(seatOf(botId, card.seat), card.ownerId);
  }

  if (!channel || !run) return null;
  const seen = await deps.channelFor(actor, channel);
  if (!seen) return null;
  if (!seen.agentIds.includes(botId)) return null;
  const found = await deps.runOf(actor, channel, run);
  if (!found || !seen.threadIds.includes(found.threadId)) return null;
  // A conversation can hold several employees: a run is read only as the employee that made it.
  if (found.agentId !== botId) return null;
  const own =
    "appPort" in wanted ? await deps.seatFor(botId, found.ownerId) : null;
  return confirmed(viaRun(found.events, botId, wanted, own), found.ownerId);
}
