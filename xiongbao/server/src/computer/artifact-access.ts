import type { BaseEvent } from "@ag-ui/client";
import {
  TURN_ARTIFACTS_EVENT,
  type TurnArtifactsValue,
} from "../../../shared/turn-artifacts";
import type { AgentActor } from "../agents/profile-types";
import { workspaceFilePathOf } from "../tasks/evidence-gate";
import { type ComputerSeat, parseComputerKey } from "./computer-key";

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
 * REFUSAL IS THE ONLY OTHER ANSWER. Every rule that does not hold gives `null`, and the route
 * answers that exactly as it answers "there is no such employee", so the answer cannot be used to
 * learn which conversations, runs, cards or files exist.
 */

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
  ): Promise<{ threadId: string; events: BaseEvent[] } | null>;
  /**
   * The delivery card as this person sees it: null when it is not theirs to see, else the employee
   * in charge, the computer seat (as text) its files were made on, and the files it lists.
   */
  cardFor(
    actor: AgentActor,
    taskId: string,
  ): Promise<{ botId: string; seat: string; workspaceFiles: string[] } | null>;
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

/** The run's server-written events of one name, as their values. */
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

function viaRun(
  events: BaseEvent[],
  botId: string,
  path: string,
): ComputerSeat | null {
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
  const listing = announced.find((turn) => turn.files.includes(path));
  if (listing) return seatOf(botId, listing.seat);

  // Delivered on the run: the delivery event carries no seat, so it is the seat the same run
  // announced for this employee. One computer or none; two different ones are ambiguous.
  const delivered = valuesOf(events, DELIVERED_EVENT).some((value) => {
    if (!isRecord(value)) return false;
    const deliverable = isRecord(value.deliverable)
      ? value.deliverable.workspaceFiles
      : undefined;
    return (
      strings(deliverable).includes(path) ||
      strings(value.workspaceFiles).includes(path)
    );
  });
  if (!delivered) return null;
  const seats = new Set(announced.map((turn) => turn.seat));
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
  const seat = await seatFor(actor, botId, path, scope, deps);
  return seat ? { seat } : null;
}

async function seatFor(
  actor: AgentActor,
  botId: string,
  path: string,
  scope: ArtifactScope,
  deps: ArtifactAccessDeps,
): Promise<ComputerSeat | null> {
  const { channel, run, task } = scope;

  if (task !== undefined) {
    // One kind of scope at a time.
    if (channel !== undefined || run !== undefined || task === "") return null;
    const card = await deps.cardFor(actor, task);
    if (!card || card.botId !== botId) return null;
    if (!strings(card.workspaceFiles).includes(path)) return null;
    return seatOf(botId, card.seat);
  }

  if (!channel || !run) return null;
  const seen = await deps.channelFor(actor, channel);
  if (!seen) return null;
  if (!seen.agentIds.includes(botId)) return null;
  const found = await deps.runOf(actor, channel, run);
  if (!found || !seen.threadIds.includes(found.threadId)) return null;
  return viaRun(found.events, botId, path);
}
