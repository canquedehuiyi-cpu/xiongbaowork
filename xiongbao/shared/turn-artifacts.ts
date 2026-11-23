/**
 * What a turn left behind on the employee's computer: the files that are new or changed since the
 * turn began. The computer lists them, the server turns them into a download list in the chat.
 */

export const TURN_ARTIFACTS_EVENT = "computer.turn_artifacts";

/** Most files the computer looks at in one scan; past this the list is marked as cut short. */
export const ARTIFACT_SCAN_LIMIT = 20_000;

/** Most files one turn lists; the rest are only counted. */
export const ARTIFACT_LIST_LIMIT = 200;

/** Folders that hold working material rather than anything an employee would want to download. */
export const ARTIFACT_IGNORED_FOLDERS = [
  "tool-outputs",
  "node_modules",
  "__pycache__",
  ".git",
] as const;

/**
 * True when any segment of the path is an ignored folder or starts with a dot. The path is relative
 * with `/` separators (callers normalise); a backslash is an ordinary file-name character.
 */
export function isIgnoredArtifactPath(path: string): boolean {
  return path
    .split("/")
    .some(
      (segment) =>
        segment.startsWith(".") ||
        (ARTIFACT_IGNORED_FOLDERS as readonly string[]).includes(segment),
    );
}

export type TurnArtifact = {
  path: string;
  bytes: number;
  modifiedMs: number;
  change: "new" | "modified";
};

export type TurnArtifactsValue = {
  botId: string;
  seat: string;
  files: TurnArtifact[];
  scanned: number;
  scanTruncated: boolean;
  omitted: number;
};
