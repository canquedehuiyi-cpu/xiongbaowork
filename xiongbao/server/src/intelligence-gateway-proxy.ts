/**
 * The origin the Recorder's capture pass names, kept only for the Recorder (Task 14b removes it with
 * the Recorder): the rest of the back end's gateway proxy is gone.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { DeploymentConfig } from "./config";
import { isTrajectoryConnectPath } from "./recorder/trajectory-gate";
import { callerOf, ownOriginOnThisMachine } from "./request-trust";

/** Where the browser is told the gateway's client socket is, when this proxy is on. */
export const INTELLIGENCE_CLIENT_SOCKET_PATH = "/api/intelligence/client";

/** The one path that socket arrives on: Phoenix's websocket transport under the address above. */
const PROXIED_PATH = `${INTELLIGENCE_CLIENT_SOCKET_PATH}/websocket`;

export function isIntelligenceClientSocketPath(pathname: string): boolean {
  return pathname === PROXIED_PATH;
}

/**
 * The address the browser is given: on the public URL when there is one, so it is a whole URL that
 * anything holding it can open, and otherwise a path that the browser resolves against the page.
 */
export function proxiedClientSocketUrl(publicUrl: string | undefined): string {
  const base = publicUrl?.trim().replace(/\/+$/, "");
  if (!base) return INTELLIGENCE_CLIENT_SOCKET_PATH;
  return `${base.replace(/^http/, "ws")}${INTELLIGENCE_CLIENT_SOCKET_PATH}`;
}

/** XiongBao's own origin while a capture pass is answered, where it is one that may be named. */
const capturePass = new AsyncLocalStorage<string>();

/**
 * In front of the runtime: answers the Recorder's capture pass (`trajectory/connect`) knowing
 * XiongBao's own origin as the Recorder reached it, so the gateway address the pass names is one the
 * Recorder can open (see {@link capturePassOrigin}).
 *
 * Only the capture pass. The page is still told a path, which it resolves against itself, and that
 * stays right behind a proxy that ends TLS, where the connection here is `http://` and the page is
 * `https://`. The origin is the one `request-trust.ts` will vouch for (`ownOriginOnThisMachine`): a
 * caller on this machine, at one of its own loopback names. Any other request is answered as before.
 */
export function createCapturePassOrigin(
  config: Pick<DeploymentConfig, "singleUser" | "singleUserAccess">,
  basePath = "/api/copilotkit",
): MiddlewareHandler {
  return async (context, next) => {
    // The raw path, which is the one the runtime routes on.
    if (!isTrajectoryConnectPath(new URL(context.req.url).pathname, basePath))
      return next();
    const origin = ownOriginOnThisMachine(
      context.req.raw,
      callerOf(context),
      config,
    );
    if (!origin) return next();
    await capturePass.run(origin, next);
  };
}

/**
 * XiongBao's own origin, while a capture pass that may name it is being answered, and otherwise
 * undefined. The platform client makes a path-only gateway address whole on it (toolkit
 * `IntelligenceKnowingANewThread`).
 */
export function capturePassOrigin(): string | undefined {
  return capturePass.getStore();
}
