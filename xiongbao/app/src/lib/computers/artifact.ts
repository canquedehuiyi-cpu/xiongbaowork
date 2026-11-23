import type { Message } from "@ag-ui/core";
import { readOutcome } from "./activity";

/*
 * Reaching a file a Bot saved.
 *
 * A download link promises two things at once: that the address is the one the download route answers,
 * and that the file is still there. The route is `/api/computers/:botId/files/download?path=`
 * (`server/src/computer/routes.ts`), which takes the path as the Bot named it — relative to its own
 * workspace — and hands back the bytes as an attachment. The answer never carries which root it came
 * from, so the link is only reachable while a write goes to the workspace itself. It does not when the
 * deployment runs the Bot on a paired computer with a project picked: the server builds that frame
 * itself and writes the file under the project's root (`inProject` in
 * `server/src/computer/gateway.ts`), while the download route knows only the workspace. A link made
 * from the path in that case arrives at a file that is not there, so the chat draws none, and passing
 * the root through is a separate change with a security review of its own.
 *
 * A refused link is the safer failure: the line above still names the file, and the person can ask for
 * it another way. A link that 404s is worse than no link, because the chat has just said the file is
 * there.
 */

/** The call whose success means a file now exists on the Bot's computer. */
const WRITE_TOOL = "computer_write_file";

/** A path separator, whichever way the Bot or its machine wrote it. */
const SEPARATOR = /[/\\]/;

/**
 * The path as the download route must be handed it, or undefined when it is not a workspace path.
 *
 * Folders are joined with `/` and the empty segments (`//`, a leading `./`) are dropped, because that
 * is the spelling the workspace lists and resolves; `notes.md` and `./notes.md` are one file and must
 * not become two rows. A path that cannot be answered is refused rather than repaired: absolute, home
 * (`~`), a drive letter, or any `..` segment. The server confines a download anyway
 * (`assertInside` in `agent-computer/src/workspace.ts`); this is the chat not offering an address it
 * already knows ends in a refusal.
 */
export function normalizedArtifactPath(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const trimmed = path.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return undefined;
  if (/^[A-Za-z]:/.test(trimmed)) return undefined;
  const segments: string[] = [];
  for (const segment of trimmed.split(SEPARATOR)) {
    if (segment === "" || segment === ".") continue;
    // A segment that IS `..`, not one that merely starts with it: `..notes.md` is an ordinary name.
    if (segment === "..") return undefined;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}

/**
 * The address that downloads a file the Bot saved, or undefined when no link should be drawn.
 *
 * Same-origin and cookie-authenticated, like every other call this app makes, so a plain anchor
 * carries the session and the browser saves the answer under its own name. Both halves of the address
 * are encoded: a file name may hold a space, a `?` or a `#`, and none of them may open a second query
 * or a fragment on the way back.
 */
export function artifactDownloadHref(
  botId: string | undefined | null,
  path: unknown,
): string | undefined {
  return workspaceFileHref("download", botId, path);
}

/** The routes under `/api/computers/:botId/files/` that read one file by path. */
export type FileAction = "download" | "preview" | "text";

/** The address of one of the file routes, for a path with no scope yet. Same refusals as {@link artifactDownloadHref}. */
export function workspaceFileHref(
  action: FileAction,
  botId: string | undefined | null,
  path: unknown,
): string | undefined {
  if (typeof botId !== "string" || botId.trim() === "") return undefined;
  const normalised = normalizedArtifactPath(path);
  if (normalised === undefined) return undefined;
  return `/api/computers/${encodeURIComponent(botId.trim())}/files/${action}?path=${encodeURIComponent(normalised)}`;
}

/**
 * The address of a file route for a file the server announced, with the scope that tells the route
 * where it was announced: a conversation and the run that listed it (`channel` + `run`), or a
 * delivery card (`task`). The route accepts a path only from the run whose event listed it, so an
 * address must carry that run's id, not the id of whichever run came last.
 *
 * Undefined when no address should be drawn: the same refusals as {@link artifactDownloadHref}, and a
 * scope with an empty id.
 */
export function scopedFileHref(
  action: FileAction,
  input: {
    botId: string;
    path: string;
    scope?: { channel: string; run: string } | { task: string };
  },
): string | undefined {
  const base = workspaceFileHref(action, input.botId, input.path);
  if (base === undefined) return undefined;
  const scope = input.scope;
  if (scope === undefined) return base;
  const query = (name: string, value: string) =>
    `&${name}=${encodeURIComponent(value)}`;
  if ("task" in scope)
    return scope.task.trim() === ""
      ? undefined
      : base + query("task", scope.task);
  if (scope.channel.trim() === "" || scope.run.trim() === "") return undefined;
  return base + query("channel", scope.channel) + query("run", scope.run);
}

/** The download address for a file the server announced (see {@link scopedFileHref}). */
export function artifactHref(input: {
  botId: string;
  path: string;
  scope?: { channel: string; run: string } | { task: string };
}): string | undefined {
  return scopedFileHref("download", input);
}

/**
 * Whether the answer says the files are where this address looks for them.
 *
 * THE SERVER'S ANSWER ONLY. `workspace` is what a deployment that runs the Bot in its own container
 * answers, and it is the only case a download link can be reached; `device` means the frames go to a
 * paired computer, whose files may live under a project root the route does not know. An answer that
 * has not arrived, or that could not be read at all, is neither of those and gets no link: a link is a
 * promise that the file is there, and the chat has no way to keep one in that case.
 *
 * One rule for both surfaces that hand out a link — the line for a saved file and the turn's list — so
 * neither can be the one that guessed.
 */
export function isWorkspaceScope(machine: unknown): boolean {
  return machine === "workspace";
}

/**
 * Which folder to list for a path, as the workspace names folders: `.` for the workspace itself.
 *
 * Listing is recursive and every entry it returns is already root-relative
 * (`agent-computer/src/workspace.ts`), so the folder only bounds the walk. Starting it at the folder
 * the file was written to keeps a Bot that works in one place out of a listing that stops at
 * `truncated` before it ever reaches the file.
 */
export function artifactFolderOf(path: string): string {
  const normalised = normalizedArtifactPath(path) ?? "";
  const cut = normalised.lastIndexOf("/");
  return cut < 0 ? "." : normalised.slice(0, cut);
}

/**
 * The path a saved file is known by: the one the computer answered with, else the one it was asked for.
 *
 * The answer is preferred because it is the server's, and the line should name what was written.
 * Either half may be missing or unmappable, which is the same as not knowing where the file is: no
 * link.
 */
export function artifactPathOf(
  resultPath: unknown,
  argumentPath: unknown,
): string | undefined {
  return (
    normalizedArtifactPath(resultPath) ?? normalizedArtifactPath(argumentPath)
  );
}

/** What the arguments of a drawn tool call hold, when they are readable JSON. */
function argumentField(raw: unknown, field: string): unknown {
  if (typeof raw !== "string") return undefined;
  try {
    return (JSON.parse(raw) as Record<string, unknown>)?.[field];
  } catch {
    return undefined;
  }
}

/**
 * The files this turn saved, in the order they were first written, workspace-relative.
 *
 * THE TURN, NOT THE WORKSPACE. The note is the answer to "what did you just make me", so it lists the
 * successful `computer_write_file` calls after the last message the person sent — the same events the
 * transcript draws its lines from. It is never a directory listing: a workspace holds everything that
 * Bot has ever written, and presenting that as this turn's work would be a lie about what happened.
 *
 * Writing the same file twice, which is what appending does, is one artifact. A call that was refused,
 * failed, was declined, or was done by the person themselves saved nothing here, so it is not one
 * either.
 */
export function writtenPathsInTurn(
  messages: ReadonlyArray<Readonly<Message>>,
): string[] {
  let turn = 0;
  for (let index = 0; index < messages.length; index++)
    if (messages[index]?.role === "user") turn = index + 1;

  // Results are gathered over the whole history first: a call is answered after it, and an older
  // answer must never be mistaken for this turn's.
  const answers = new Map<string, unknown>();
  for (const message of messages) {
    const callId = (message as { toolCallId?: unknown }).toolCallId;
    if (message.role === "tool" && typeof callId === "string")
      answers.set(callId, (message as { content?: unknown }).content);
  }

  const paths: string[] = [];
  for (const message of messages.slice(turn)) {
    if (message.role !== "assistant") continue;
    for (const call of Array.isArray(message.toolCalls)
      ? message.toolCalls
      : []) {
      const shape = call as {
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      if (shape.function?.name !== WRITE_TOOL) continue;
      if (typeof shape.id !== "string") continue;
      const outcome = readOutcome(answers.get(shape.id));
      if (!outcome) continue;
      // Only a file the Bot actually wrote: a refusal, a failure, a step held for an answer or one
      // the person did themselves has no artifact behind it.
      if (
        outcome.ok !== true ||
        outcome.refused === true ||
        outcome.doneByPerson === true
      )
        continue;
      const path = artifactPathOf(
        outcome.path,
        argumentField(shape.function.arguments, "path"),
      );
      if (path !== undefined && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}
