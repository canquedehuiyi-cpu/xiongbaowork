import type { Attachment } from "@copilotkit/react-core/v2";
import {
  getChipsByTrigger,
  isSegmentsEmpty,
  mergeAdjacentTextSegments,
  type Segment,
  segmentsToPlainText,
  text,
} from "prompt-area/helpers";

/**
 * Pure boundary between prompt-area segments and OpenBot's message draft model.
 */

export const AGENT_TRIGGER = "@";
export const COMMAND_TRIGGER = "/";
/**
 * A `@` chip whose value carries this prefix names a crew's flow rather than a coworker.
 *
 * The mention menu has one list because that is where a person looks to say who answers, and a crew
 * is not an addressable answering agent — picking one starts a run instead of sending a turn, so the
 * two cannot share the `agentId` field.
 */
export const CREW_CHIP_PREFIX = "crew:";

export type ComposerDraft = {
  /** Plain text, with chips flattened back to `@Agent` / `/command`. */
  text: string;
  /**
   * The single agent this message is addressed to, or `null` to let the channel pick its default.
   *
   * Exactly one responding agent per message, which is enforced on the
   * way in by `enforceSingleAgent` rather than validated here.
   */
  agentId: string | null;
  /**
   * The template of the crew this message asks to run, or `null`.
   *
   * Set from a crew chip's value with the prefix taken off, which is the template id the run
   * endpoint wants. A draft carrying this is not a chat turn, and the caller that sends it branches
   * on it before anything reaches the turn machinery.
   */
  crewTemplateId: string | null;
  /** Commands that survive into the sent message, in the order they were typed. */
  commandIds: string[];
  isEmpty: boolean;
  attachments: Attachment[];
};

export function toDraft(
  segments: Segment[],
  attachments: Attachment[] = [],
): ComposerDraft {
  const agentChips = getChipsByTrigger(segments, AGENT_TRIGGER);
  const crewChips = agentChips.filter((chip) =>
    chip.value.startsWith(CREW_CHIP_PREFIX),
  );
  const coworkerChips = agentChips.filter(
    (chip) => !chip.value.startsWith(CREW_CHIP_PREFIX),
  );
  const commandChips = getChipsByTrigger(segments, COMMAND_TRIGGER);

  return {
    text: segmentsToPlainText(segments).trim(),
    agentId: coworkerChips.at(-1)?.value ?? null,
    crewTemplateId:
      crewChips.at(-1)?.value.slice(CREW_CHIP_PREFIX.length) ?? null,
    commandIds: commandChips.map((chip) => chip.value),
    isEmpty: isSegmentsEmpty(segments),
    attachments,
  };
}

/**
 * A pasted screenshot with no text is the whole feature: `isEmpty` only answers "is there text",
 * so an attachment alone must be enough to unlock Send rather than riding on top of it. An
 * upload still in flight holds the gate either way, since sending would race the file that has
 * not finished becoming a source yet.
 */
export function canSendDraft(draft: ComposerDraft): boolean {
  if (
    draft.attachments.some((attachment) => attachment.status === "uploading")
  ) {
    return false;
  }

  return draft.attachments.length > 0 || !draft.isEmpty;
}

/**
 * Collapse repeated mentions of one kind to the most recent of that kind, identity on no-op.
 *
 * A coworker and a crew can both be in the draft — "ask the crew, and 阿审 specifically" is a thing
 * a person means — so the single-answer rule runs per kind rather than across every `@` chip.
 * Position decides which one stays, because the same name can legitimately be picked twice.
 */
export function enforceSingleAgent(segments: Segment[]): Segment[] {
  const agentChips = getChipsByTrigger(segments, AGENT_TRIGGER);
  if (agentChips.length <= 1) {
    return segments;
  }

  const kindOf = (value: string) =>
    value.startsWith(CREW_CHIP_PREFIX) ? "crew" : "coworker";
  const lastOfKind = new Map<string, number>();
  segments.forEach((segment, position) => {
    if (segment.type === "chip" && segment.trigger === AGENT_TRIGGER) {
      lastOfKind.set(kindOf(segment.value), position);
    }
  });

  const kept = segments.filter((segment, position) => {
    if (segment.type !== "chip" || segment.trigger !== AGENT_TRIGGER) {
      return true;
    }
    return lastOfKind.get(kindOf(segment.value)) === position;
  });

  return mergeAdjacentTextSegments(kept);
}

/**
 * What a `/command` does once it has been picked from the dropdown.
 *
 * - `chip` keeps the chip in the message, so the runtime receives it as structured data.
 * - `prompt` expands into editable text, for the channel's seeded suggested prompts.
 * - `action` runs client-side and never reaches the runtime.
 *
 * prompt-area always resolves a dropdown selection into a chip, so `prompt` and `action` are
 * applied here on the next change instead of being special-cased inside the editor.
 */
export type CommandKind = "chip" | "prompt" | "action";

export type CommandOption = {
  id: string;
  name: string;
  description?: string;
  /** Defaults to `chip`. */
  kind?: CommandKind;
  /** Text substituted for the command when `kind` is `prompt`. */
  prompt?: string;
  /** Side effect run when `kind` is `action`. */
  run?: () => void;
};

export type AppliedCommands = {
  segments: Segment[];
  /** Actions to run after the new segments are committed to state. */
  actions: (() => void)[];
};

/**
 * Rewrites `prompt` and `action` command chips, leaving `chip` commands (and everything else)
 * alone. Side effects are returned rather than run so the transform stays pure and testable.
 */
export function applyCommandChips(
  segments: Segment[],
  commands: readonly CommandOption[],
): AppliedCommands {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const actions: (() => void)[] = [];
  let changed = false;

  const rewritten = segments.flatMap<Segment>((segment) => {
    if (segment.type !== "chip" || segment.trigger !== COMMAND_TRIGGER) {
      return [segment];
    }

    const command = byId.get(segment.value);
    const kind = command?.kind ?? "chip";

    if (kind === "prompt") {
      changed = true;
      return command?.prompt ? [text(command.prompt)] : [];
    }

    if (kind === "action") {
      changed = true;
      if (command?.run) {
        actions.push(command.run);
      }
      return [];
    }

    return [segment];
  });

  return {
    segments: changed ? mergeAdjacentTextSegments(rewritten) : segments,
    actions,
  };
}
