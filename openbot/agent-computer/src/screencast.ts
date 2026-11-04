/**
 * Live screen and live input over one WebSocket, using Chrome's own screencast.
 *
 * Chrome pushes frames as the page changes, which supports human takeover better than polling a PNG
 * once a second.
 *
 * This follows permissively-licensed references: `steel-dev/steel-browser`'s `casting.handler.ts`
 * (Apache-2.0) for the server loop and Chrome DevTools' `InputModel.ts` (BSD-3) for key event
 * translation.
 *
 * noVNC is not used because it requires Xvfb, x11vnc and websockify, while this container runs
 * headless. This implementation streams the page and forwards input through the Chrome DevTools
 * Protocol.
 */
import type { CDPSession, Page } from "playwright";
import {
  type FrameMessage,
  type Screencast,
  type ScreencastClient,
  type ScreencastOptions,
  startScreencastOn,
} from "./screencast-session";

/*
 * The protocol and the key translation live in `screencast-session.ts`, which names no browser
 * library, so the runner on a person's own machine casts with the same code. Re-exported here so every
 * existing import of these names keeps working.
 */
export type {
  FrameMessage,
  InputMessage,
  Screencast,
  ScreencastClient,
  ScreencastOptions,
} from "./screencast-session";

/** Playwright's CDP session, seen as the structural one the cast is written against. */
export function screencastClientOf(session: CDPSession): ScreencastClient {
  type Method = Parameters<CDPSession["send"]>[0];
  return {
    on: (event, listener) => session.on(event, listener),
    send: (method, params) => session.send(method as Method, params as never),
    detach: () => session.detach(),
  };
}

/**
 * Start casting `page` to `onFrame`, and return a handle that accepts input.
 *
 * Capping the size matters because the cost of a frame is mostly encoding, and oversized casts waste
 * bandwidth.
 */
export async function startScreencast(
  page: Page,
  onFrame: (frame: FrameMessage) => void,
  options: ScreencastOptions = {},
): Promise<Screencast> {
  const client: CDPSession = await page.context().newCDPSession(page);
  return startScreencastOn(screencastClientOf(client), onFrame, options);
}
