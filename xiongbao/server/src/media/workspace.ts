/**
 * A generated picture, put in the coworker's own computer: `generated/<id>.png` in its workspace.
 *
 * WHY. A picture lives in `generated_media` and is read at `/api/media/<id>`, behind the person's
 * session, so a script on the computer (python-docx, python-pptx) cannot fetch it. The coworker puts
 * pictures into documents all the time, so the same bytes are written where its scripts can open them.
 *
 * HOW. The computer's file write takes text, so the bytes go over as base64 text in pieces, each under
 * the write limit, and `base64 -d` turns them back into the picture in one command; the text file is
 * removed either way. Everything goes through the gateway's own write and command tools, so the
 * person's rules, approvals and trail apply as they do to the coworker's other file writes. A write
 * that would need the person's answer is refused here instead (this call has no conversation of its
 * own to ask in), and the caller falls back to the link.
 *
 * VIDEO IS NOT WRITTEN: it can be tens of megabytes, so it stays a link.
 */
import { outsideApprovalContext } from "../approvals/types";
import type { ComputerSeat } from "../computer/computer-key";
import type { ActionActor, ComputerGateway } from "../computer/gateway";

/** Where pictures go, relative to the workspace root. */
export const WORKSPACE_MEDIA_DIR = "generated";

/** Characters of base64 per write: a multiple of four, well under the computer's 1,000,000-byte write limit. */
const CHUNK_CHARS = 600_000;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The workspace path a picture is written to. */
export function workspaceImagePath(id: string, mimeType: string): string {
  return `${WORKSPACE_MEDIA_DIR}/${id}.${EXTENSIONS[mimeType] ?? "png"}`;
}

/** Puts one picture in the workspace and answers its path; throws, with a reason, if it could not. */
export async function writeImageToWorkspace(
  gateway: Pick<ComputerGateway, "writeFile" | "runCommand">,
  seat: ComputerSeat,
  actor: ActionActor,
  file: { id: string; mimeType: string; bytes: Uint8Array },
): Promise<string> {
  const path = workspaceImagePath(file.id, file.mimeType);
  const staging = `${path}.b64`;
  const encoded = Buffer.from(file.bytes).toString("base64");
  // Outside the generating call's own approval context: see the top of this file.
  return outsideApprovalContext(async () => {
    try {
      for (let at = 0; at < encoded.length; at += CHUNK_CHARS)
        await gateway.writeFile(seat, actor, {
          path: staging,
          contents: encoded.slice(at, at + CHUNK_CHARS),
          append: at > 0,
        });
      const decoded = await gateway.runCommand(seat, actor, {
        command: `base64 -d ${staging} > ${path} && rm -f ${staging}`,
        timeoutMs: 60_000,
      });
      if (decoded.exitCode !== 0 || decoded.timedOut)
        throw new Error("the computer could not decode the picture");
      return path;
    } catch (error) {
      // Leave no half-written text behind; the picture itself was never made.
      await gateway
        .runCommand(seat, actor, {
          command: `rm -f ${staging} ${path}`,
          timeoutMs: 30_000,
        })
        .catch(() => undefined);
      throw error;
    }
  });
}

export type WorkspaceMedia = (file: {
  id: string;
  mimeType: string;
  bytes: Uint8Array;
}) => Promise<string | undefined>;

/**
 * The tool's way into the coworker's computer: the path the picture was written to, or undefined when
 * this coworker has no computer for this person (a Team Bot's teammate, no computer configured).
 */
export function workspaceMedia(options: {
  gateway: ComputerGateway;
  /** The seat and the actor for this run, or undefined when there is no computer to write to. */
  resolve: () => Promise<
    { seat: ComputerSeat; actor: ActionActor } | undefined
  >;
}): WorkspaceMedia {
  return async (file) => {
    const target = await options.resolve();
    if (!target) return undefined;
    return writeImageToWorkspace(
      options.gateway,
      target.seat,
      target.actor,
      file,
    );
  };
}
