import type { OpenBotRole } from "../auth/roles";
import { parseRunnerAddress } from "../devices/channel";
import type { ScreenWatch } from "../devices/screen";
import { currentTenant, runAsTenant } from "../tenant/context";
import { computerSocketPath } from "./stream-path";

/** What the proxied live-screen or terminal socket carries once upgraded: where to connect inward. */
export type ComputerStreamSocketData = {
  upstream: string;
};

export type ComputerStreamUpgradeDeps = {
  /** Whether the deployment has a computer at all; without one the stream answers 503. */
  computerConfigured: boolean;
  /** The session guard, applied by hand because middleware does not run on an upgrade. */
  resolveRequestActor: (
    request: Request,
  ) => Promise<{ id: string; role: OpenBotRole }>;
  /** Who may watch this Bot's screen: `computerAccessCheck(agentProfileStore)`. */
  accessCheck: (
    actor: { id: string; role: OpenBotRole },
    botId: string,
  ) => Promise<boolean>;
  /**
   * Where the watcher's seat on this Bot is (their computer, or the Bot's own if it is isolated):
   * the computer gateway's `seatFor` then `locate`, or `undefined` when no gateway exists.
   */
  locate: ((botId: string, viewerId: string) => Promise<string>) | undefined;
  /** The inward socket URL for a located computer, under that seat's own token. */
  toStreamUrl: (
    baseUrl: string,
    botId: string,
    viewerId: string,
    socket: "stream" | "terminal",
  ) => string | Promise<string>;
  /**
   * On a single-user OpenBot, whether this request is somebody it admits at all (request-trust.ts):
   * a sentence to refuse with, or null. Asked before the session, which admits everybody there.
   */
  refuse?: (request: Request) => string | null;
};

/**
 * What a live-screen socket carries when the Bot's computer is a tenant's own machine (F2 stage 2).
 *
 * Nothing is dialled for it. The frames come up the runner's socket and `devices/screen.ts` relays
 * them, so this is only who is watching which Bot on which device, fixed here and never re-read from
 * anything the socket later says.
 */
export type DeviceScreenSocketData = { screen: ScreenWatch };

/** The one call this needs of Bun's server. */
export type ComputerStreamServer = {
  upgrade(
    request: Request,
    options: { data: ComputerStreamSocketData | DeviceScreenSocketData },
  ): boolean;
};

/**
 * The live screen's (or the terminal's) WebSocket upgrade: `undefined` once upgraded, a `Response`
 * otherwise. Whoever may watch a Bot's screen may watch its terminal, and typing into either is the
 * computer's own question, asked of the wheel.
 *
 * An upgrade runs ahead of Hono, so no middleware has opened a tenant frame for it. Every question
 * asked here after the session is known — may this person watch this Bot, where is its computer — is
 * asked in the frame of the person signed in (G01-E P4). Asked with no
 * frame they used to read as `system`, which cannot see a private Bot, so an owner was told their own
 * Bot did not exist; under the frame guard they would throw.
 */
export async function handleComputerStreamUpgrade(
  deps: ComputerStreamUpgradeDeps,
  request: Request,
  server: ComputerStreamServer,
): Promise<Response | undefined> {
  const named = computerSocketPath(new URL(request.url).pathname);
  if (named === null) {
    return new Response("There is no such Bot.", { status: 404 });
  }
  const streamBotId = named.botId;
  if (!deps.computerConfigured) {
    return new Response("No computer is configured.", { status: 503 });
  }
  // On a single-user OpenBot the guard below admits everybody, so first: is this somebody it may admit.
  const notHere = deps.refuse?.(request) ?? null;
  if (notHere) return new Response(notHere, { status: 403 });
  // The session guard, applied by hand because middleware does not run on an upgrade. An
  // unauthenticated socket here would be the whole point of the proxy defeated.
  const actor = await deps.resolveRequestActor(request).catch(() => null);
  if (!actor) {
    return new Response("Sign in first.", { status: 401 });
  }
  return runAsTenant(actor.id, async () => {
    // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
    // so signing in is not enough: without this, anybody signed in watches anybody's Bot work. And
    // seeing a Team Bot is not enough either: its screen is its owner's signed-in browser. A person's
    // own OpenBot browser is that person's alone, an administrator's neither: the same check says so.
    if (
      !(await deps.accessCheck({ id: actor.id, role: actor.role }, streamBotId))
    ) {
      return new Response("There is no such Bot.", { status: 404 });
    }
    /*
     * Through the gateway, not the provider.
     *
     * `gateway.locate` runs checkComputerAddress; `provider.locate` does not, and the URL built
     * below carries COMPUTER_TOKEN in its query string. A provider that answered with a foreign
     * host was handed the deployment's computer token, which is the case that check was written
     * for. Every acting path already went through the gateway; this one did not.
     */
    let upstream: string;
    try {
      // The watcher's own seat on that Bot: their computer, or the Bot's own if it is isolated.
      const streamBase = deps.locate
        ? await deps.locate(streamBotId, actor.id)
        : undefined;
      if (!streamBase) {
        return new Response("No computer address is configured.", {
          status: 503,
        });
      }
      /*
       * A tenant's own machine is not a URL to dial: its screen is relayed from the runner's socket.
       *
       * Admitted only when the machine belongs to the tenant of the person asking. The access check
       * above already confined this to a Bot they may watch, and a Bot runs on its owner's machines;
       * this compares the two facts instead of assuming one follows from the other, so a stranger who
       * somehow passed the first question still meets the same "no such Bot" as everybody else.
       */
      const device = parseRunnerAddress(streamBase);
      // A paired machine relays its screen; it has no terminal to proxy.
      if (device && named.socket === "terminal") {
        return new Response(
          "This Bot's terminal is not available on a paired machine.",
          { status: 503 },
        );
      }
      if (device) {
        const viewerTenant = currentTenant();
        if (device.tenantId !== viewerTenant) {
          return new Response("There is no such Bot.", { status: 404 });
        }
        const data: DeviceScreenSocketData = {
          screen: {
            viewerTenant,
            userId: actor.id,
            target: device,
            botId: streamBotId,
          },
        };
        return server.upgrade(request, { data })
          ? undefined
          : new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      upstream = await deps.toStreamUrl(
        streamBase,
        streamBotId,
        actor.id,
        named.socket,
      );
    } catch (error) {
      // Said out loud rather than falling back to another Bot's computer, which is the failure this
      // whole path exists to prevent.
      return new Response(
        error instanceof Error
          ? error.message
          : "That Bot's computer could not be reached.",
        { status: 502 },
      );
    }
    if (server.upgrade(request, { data: { upstream } })) {
      return undefined;
    }
    return new Response("Expected a WebSocket upgrade.", { status: 400 });
  });
}
