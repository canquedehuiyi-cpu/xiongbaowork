/**
 * The live screen of a coworker's browser on a tenant's own machine (F2 stage 2, R-a).
 *
 * The frames ride the runner socket the machine already opened: the device listens on nothing, so the
 * server cannot dial in to watch, and a second connection would be a second credential to keep. The
 * picture is Chrome's own screencast JPEG, base64 as Chrome hands it over, so neither side re-encodes.
 *
 * Who a frame belongs to is never read from the frame. The server keys it by the tenant and device the
 * socket authenticated as, plus the Bot named here, and a Bot that nobody asked to watch is dropped on
 * the floor. The runner, for its part, casts only a Bot the server started a screen for.
 */

/** Server to runner: begin casting this coworker's browser, following whatever page it has open. */
export type ScreenStartFrame = {
  type: "screen.start";
  tenantId: string;
  botId: string;
};

/** Server to runner: nobody is watching any more. */
export type ScreenStopFrame = { type: "screen.stop"; botId: string };

/** Server to runner: one thing the person holding the wheel did. Checked again on the device. */
export type ScreenInputFrame = {
  type: "screen.input";
  botId: string;
  input: unknown;
};

/** Runner to server: one picture of the page. */
export type ScreenImageFrame = {
  type: "screen.frame";
  botId: string;
  /** Base64 JPEG, exactly as Chrome encoded it. */
  data: string;
  width: number;
  height: number;
};

/**
 * Runner to server: what the cast is doing, when that is not a picture.
 *
 * `idle` is a coworker with no browser open on this machine yet: the screen starts by itself the
 * moment one opens, which is the moment a person watching wants to see.
 */
export type ScreenStatusFrame = {
  type: "screen.status";
  botId: string;
  state: "idle" | "casting" | "error";
  error?: string;
};

export type ScreenDownFrame =
  | ScreenStartFrame
  | ScreenStopFrame
  | ScreenInputFrame;
export type ScreenUpFrame = ScreenImageFrame | ScreenStatusFrame;

/**
 * The largest picture either side carries, in base64 characters.
 *
 * A 1280x800 JPEG at the quality the runner asks for is well under a megabyte; something much larger
 * is not a frame, and refusing it keeps one runaway page from filling a person's uplink.
 */
export const MAX_SCREEN_FRAME_CHARS = 4 * 1024 * 1024;

/** The runner's cast settings: the container's viewport, a little lower quality for a home uplink. */
export const DEVICE_SCREENCAST = {
  maxWidth: 1280,
  maxHeight: 800,
  quality: 60,
} as const;

/** True for every frame type this protocol owns, in either direction. */
export function isScreenFrameType(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("screen.");
}

function botOf(frame: Record<string, unknown>): string | null {
  const botId = typeof frame.botId === "string" ? frame.botId.trim() : "";
  return botId && botId.length <= 200 ? botId : null;
}

function dimension(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 10_000
    ? value
    : null;
}

/**
 * A frame from a runner, checked before anything is relayed.
 *
 * Null for anything that is not a well-formed picture or status: a malformed frame is dropped rather
 * than passed to a person's browser to fail in its decoder.
 */
export function readScreenUpFrame(
  frame: Record<string, unknown>,
): ScreenUpFrame | null {
  const botId = botOf(frame);
  if (!botId) return null;
  if (frame.type === "screen.frame") {
    const width = dimension(frame.width);
    const height = dimension(frame.height);
    if (
      typeof frame.data !== "string" ||
      !frame.data ||
      frame.data.length > MAX_SCREEN_FRAME_CHARS ||
      width === null ||
      height === null
    )
      return null;
    return { type: "screen.frame", botId, data: frame.data, width, height };
  }
  if (frame.type === "screen.status") {
    if (
      frame.state !== "idle" &&
      frame.state !== "casting" &&
      frame.state !== "error"
    )
      return null;
    return {
      type: "screen.status",
      botId,
      state: frame.state,
      ...(typeof frame.error === "string" && frame.error
        ? { error: frame.error.slice(0, 500) }
        : {}),
    };
  }
  return null;
}

/** A frame from the server, checked by the runner before it touches a browser. */
export function readScreenDownFrame(
  frame: Record<string, unknown>,
): ScreenDownFrame | null {
  const botId = botOf(frame);
  if (!botId) return null;
  if (frame.type === "screen.start") {
    const tenantId =
      typeof frame.tenantId === "string" ? frame.tenantId.trim() : "";
    return tenantId ? { type: "screen.start", tenantId, botId } : null;
  }
  if (frame.type === "screen.stop") return { type: "screen.stop", botId };
  if (frame.type === "screen.input")
    return { type: "screen.input", botId, input: frame.input };
  return null;
}
