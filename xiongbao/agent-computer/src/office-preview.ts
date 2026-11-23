import { createHash, randomBytes } from "node:crypto";
import { basename, extname, posix } from "node:path";
import type { CommandRunner } from "./shell";
import type { Workspace } from "./workspace";
import { WorkspaceFileError, WorkspaceFileNotFoundError } from "./workspace";

/**
 * Office files turned into PDF for the preview pane.
 *
 * The converted file is kept in a hidden folder of the workspace (a leading dot, so the per-turn
 * artifact list ignores it) under a name made of the source path and its modification time: an edit
 * changes the name, so a stale PDF is never served and nothing needs invalidating.
 */
export const PREVIEW_CACHE_DIR = ".xb-preview";

/** How long one conversion may run. */
export const CONVERT_TIMEOUT_MS = 60_000;

export function pdfCachePath(source: string, mtimeMs: number): string {
  const key = createHash("sha1").update(source).digest("hex").slice(0, 16);
  return `${PREVIEW_CACHE_DIR}/${key}-${Math.trunc(mtimeMs)}.pdf`;
}

/** One word for a POSIX shell: single-quoted, so spaces, `#`, `;` and quotes stay data. */
export function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The runner takes one command string, so each argument is quoted here and none is ever spliced raw. */
function commandLine(args: readonly string[]): string {
  return args.map(shellWord).join(" ");
}

export class OfficeConversionError extends Error {}

export type PdfResult =
  | { path: string; cached: boolean }
  | { unavailable: true };

// The same source converted twice at once shares one run rather than racing on one output name.
// Kept per workspace: two employees' same-named files with the same time are different files.
const runningByWorkspace = new WeakMap<
  Workspace,
  Map<string, Promise<PdfResult>>
>();

/** A relative path that can never be read as an option: `-x.docx` becomes `./-x.docx`. */
function asOperand(path: string): string {
  const clean = posix.normalize(path);
  return clean.startsWith("/") || clean.startsWith("./") ? clean : `./${clean}`;
}

/** Remove leftovers of conversions that were killed before they could clean up. */
const STALE_MINUTES = 10;

export async function convertToPdf(i: {
  workspace: Workspace;
  run: CommandRunner;
  path: string;
  soffice?: string;
}): Promise<PdfResult> {
  // Resolved by the workspace first: a path outside it is refused before any command exists.
  const info = await i.workspace.stat(i.path);
  if (info.kind !== "file") {
    throw new WorkspaceFileError(`${i.path} is a folder, not a file.`);
  }
  const target = pdfCachePath(i.path, info.modifiedMs);
  // A cache folder that is a link out of the workspace is refused here, before any command runs.
  await i.workspace.stat(PREVIEW_CACHE_DIR).catch((error: unknown) => {
    if (error instanceof WorkspaceFileNotFoundError) return null;
    throw error;
  });
  const hit = await i.workspace.stat(target).catch((error: unknown) => {
    if (error instanceof WorkspaceFileNotFoundError) return null;
    throw error;
  });
  if (hit) return { path: target, cached: true };

  let running = runningByWorkspace.get(i.workspace);
  if (!running) {
    running = new Map();
    runningByWorkspace.set(i.workspace, running);
  }
  const pending = running.get(target);
  if (pending) return pending;
  const table = running;
  const work = convert(i, target).finally(() => table.delete(target));
  table.set(target, work);
  return work;
}

async function convert(
  i: { run: CommandRunner; path: string; soffice?: string },
  target: string,
): Promise<PdfResult> {
  const work = `${PREVIEW_CACHE_DIR}/.tmp-${randomBytes(6).toString("hex")}`;
  const produced = `${work}/${basename(i.path, extname(i.path))}.pdf`;
  // A profile folder of its own, so two conversions never queue behind one LibreOffice instance.
  // The profile lives under /tmp, named by random hex, so no workspace path is spliced into a URL.
  const profileDir = `/tmp/xb-soffice-${randomBytes(6).toString("hex")}`;
  const profile = `-env:UserInstallation=file://${profileDir}`;
  try {
    await i.run
      .run({
        command: `[ -d ${shellWord(PREVIEW_CACHE_DIR)} ] && ${commandLine(["find", PREVIEW_CACHE_DIR, "-maxdepth", "1", "-name", ".tmp-*", "-mmin", `+${STALE_MINUTES}`, "-exec", "rm", "-rf", "{}", "+"])}; true`,
        fromRoot: true,
        timeoutMs: 15_000,
      })
      .catch(() => undefined);
    const converted = await i.run.run({
      command: `mkdir -p ${shellWord(work)} && ${commandLine([i.soffice ?? "soffice", "--headless", profile, "--convert-to", "pdf", "--outdir", work, asOperand(i.path)])}`,
      fromRoot: true,
      timeoutMs: CONVERT_TIMEOUT_MS,
    });
    if (converted.exitCode === 127) return { unavailable: true };
    if (converted.timedOut) {
      throw new OfficeConversionError(
        "The conversion took too long and was stopped.",
      );
    }
    if (converted.exitCode !== 0) {
      throw new OfficeConversionError(
        `The file could not be converted to PDF. ${converted.stderr.trim()}`.trim(),
      );
    }
    const moved = await i.run.run({
      command: commandLine(["mv", "-f", "--", produced, target]),
      fromRoot: true,
      timeoutMs: 15_000,
    });
    if (moved.exitCode !== 0) {
      throw new OfficeConversionError(
        `The file could not be converted to PDF. ${converted.stderr.trim()}`.trim(),
      );
    }
    return { path: posix.normalize(target), cached: false };
  } finally {
    await i.run
      .run({
        command: commandLine(["rm", "-rf", "--", work, profileDir]),
        fromRoot: true,
        timeoutMs: 15_000,
      })
      .catch(() => undefined);
  }
}
