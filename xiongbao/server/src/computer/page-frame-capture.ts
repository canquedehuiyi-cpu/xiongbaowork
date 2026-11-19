/**
 * Photographing the page a navigation opened, and filing it under the tool call that opened it.
 *
 * One keeper, built over whatever can say whether its computer is up and take the picture: the
 * gateway does it on every navigation it carries (so a turn the server runs itself has a frame, as
 * a browser's has), and the route keeps for a gateway that does not (`keepsFrames`). Either way a
 * navigation is photographed once.
 */
import type { ComputerSeat } from "./computer-key";
import { seatText } from "./computer-key";
import type { PageFrameStore } from "./page-frames";

/** The two reads the keeper needs of a computer, and how its screen is shared. */
export type FrameSource = {
  provider: { isolation: "per-person" | "shared" };
  status(seat: ComputerSeat): Promise<{ state: string }>;
  screenshot(seat: ComputerSeat): Promise<{ base64: string; url?: string }>;
};

export function createFrameKeeper(
  source: FrameSource,
  pageFrames: PageFrameStore | undefined,
) {
  /**
   * Whether the same page is on both, ignoring the two ways one page spells itself.
   *
   * The trailing slash a browser adds and the fragment it keeps are not different pages. A URL that
   * cannot be parsed is compared as written.
   */
  function samePage(a: string, b: string): boolean {
    const tidy = (value: string) => {
      try {
        const parsed = new URL(value);
        parsed.hash = "";
        return parsed.toString().replace(/\/$/, "");
      } catch {
        return value.replace(/\/$/, "");
      }
    };
    return tidy(a) === tidy(b);
  }

  /**
   * Whether a screenshot can be trusted to be of the page this turn opened.
   *
   * A SCREENSHOT THAT DOES NOT SAY WHAT IT IS OF IS THE ORDINARY CASE ON AN OLD COMPUTER. The url on
   * a screenshot was added after the first computers shipped, so an `agent-computer` that has not
   * been redeployed sends none. Refusing on a missing url therefore did not fail safe, it failed
   * silently and completely: on a fleet part-way through a rollout the feature kept no frames at all
   * and said nothing about why.
   *
   * So the question is asked where it means something. With a computer each there is no second Bot
   * to race with, nothing can have moved the page between the navigation and the picture, and an
   * unknown page is this turn's page. On one shared computer another Bot's navigation lands in
   * exactly that gap, which is the case this guard exists for, and there an unknown page is refused.
   */
  function frameIsOfThisPage(
    shotUrl: string | undefined,
    pageUrl: string,
  ): { ok: true } | { ok: false; why: string } {
    if (shotUrl === undefined) {
      if (source.provider.isolation === "per-person") return { ok: true };
      return {
        ok: false,
        why: "this computer is shared and the screenshot did not say which page it is of, so it cannot be told apart from another Bot's",
      };
    }
    if (!samePage(shotUrl, pageUrl)) {
      return { ok: false, why: `the screen showed ${shotUrl}` };
    }
    return { ok: true };
  }

  /**
   * Photograph the page this turn just opened.
   *
   * Awaited rather than left running, so a surface asking for the frame the moment the turn ends
   * finds it there. A navigation already costs seconds; one screenshot inside the cluster does not
   * change how the tool feels, and a frame that arrives after the reader has gone is no frame at all.
   *
   * CHECKED AGAINST THE PAGE THE NAVIGATION REPORTED, because the screenshot is a second round trip
   * and nothing holds the browser still between them. With one computer shared by every Bot, another
   * Bot's navigation lands in that gap and this would file its page under this turn. The guard used
   * to live in the browser and was deleted when the capture moved here; it belongs on whichever side
   * does the capturing.
   *
   * Never fatal. A stored picture is a convenience for reading a conversation back, and failing the
   * navigation the Bot was asked to do because the convenience failed would be the wrong trade every
   * time. EVERY REFUSAL SAYS SO, including the two that used to return quietly: a deployment that
   * keeps no frames has to be able to find out why from its own logs rather than by reading this file.
   */
  async function keepFrameOf(
    seat: ComputerSeat,
    toolCallId: string,
    url: string,
    title: string,
  ) {
    if (!pageFrames) return;
    if (!toolCallId) {
      console.warn(
        `[computer] not keeping a frame of ${url}: the caller did not say which turn it was for.`,
      );
      return;
    }
    try {
      /*
       * Only if the computer is already up. `screenshot` goes through `locate`, which resumes a
       * suspended computer, so a convenience picture could wake a machine the culler had just put to
       * sleep and hold a navigation open for the length of a pod schedule while it did.
       */
      const status = await source.status(seat);
      if (status.state !== "ready") {
        console.warn(
          `[computer] not keeping a frame for ${toolCallId}: the computer is ${status.state}, and photographing it would wake it.`,
        );
        return;
      }
      const shot = await source.screenshot(seat);
      const verdict = frameIsOfThisPage(shot.url, url);
      if (!verdict.ok) {
        console.warn(
          `[computer] not keeping a frame for ${toolCallId}: ${verdict.why} rather than ${url}.`,
        );
        return;
      }
      await pageFrames.save({
        // Filed under the seat, so one person's pictures are never another's on the same Bot.
        computerId: seatText(seat),
        toolCallId,
        url,
        title,
        frame: shot.base64,
      });
    } catch (error) {
      console.warn(
        `[computer] could not keep a frame of ${url}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return keepFrameOf;
}
