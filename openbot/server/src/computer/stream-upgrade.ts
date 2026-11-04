import type { OpenBotRole } from "../auth/roles";
import { parseRunnerAddress } from "../devices/channel";
import type { ScreenWatch } from "../devices/screen";
import { currentTenant, runAsTenant } from "../tenant/context";
import { streamPathBotId } from "./stream-path";

/** What the proxied live-screen socket carries once upgraded. */
export type ComputerStreamSocketData = {
  upstream: string;
  ownerUserId: string;
  botId: string;
  recordingId?: string;
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
  /** The computer gateway's `locate`, or `undefined` when no gateway exists. */
  locate: ((botId: string) => Promise<string>) | undefined;
  /** The inward socket URL for a located computer. */
  toStreamUrl: (baseUrl: string, botId: string) => string;
  /** This person's active demonstration on this Bot, if one is recording. */
  activeRecording: (
    ownerUserId: string,
    botId: string,
  ) => Promise<{ id: string } | null>;
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
 * The live screen's WebSocket upgrade: `undefined` once upgraded, a `Response` otherwise.
 *
 * An upgrade runs ahead of Hono, so no middleware has opened a tenant frame for it. Every question
 * asked here after the session is known — may this person watch this Bot, where is its computer, is
 * a demonstration recording — is asked in the frame of the person signed in (G01-E P4). Asked with no
 * frame they used to read as `system`, which cannot see a private Bot, so an owner was told their own
 * Bot did not exist; under the frame guard they would throw.
 */
export async function handleComputerStreamUpgrade(
  deps: ComputerStreamUpgradeDeps,
  request: Request,
  server: ComputerStreamServer,
): Promise<Response | undefined> {
  const streamBotId = streamPathBotId(new URL(request.url).pathname);
  if (streamBotId === null) {
    return new Response("There is no such Bot.", { status: 404 });
  }
  if (!deps.computerConfigured) {
    return new Response("No computer is configured.", { status: 503 });
  }
  // The session guard, applied by hand because middleware does not run on an upgrade. An
  // unauthenticated socket here would be the whole point of the proxy defeated.
  const actor = await deps.resolveRequestActor(request).catch(() => null);
  if (!actor) {
    return new Response("Sign in first.", { status: 401 });
  }
  return runAsTenant(actor.id, async () => {
    // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
    // so signing in is not enough: without this, anybody signed in watches anybody's Bot work. And
    // seeing a Team Bot is not enough either: its screen is its owner's signed-in browser.
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
      const streamBase = deps.locate
        ? await deps.locate(streamBotId)
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
      upstream = deps.toStreamUrl(streamBase, streamBotId);
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
    const recording = await deps.activeRecording(actor.id, streamBotId);
    if (recording) upstream += `&recording=${encodeURIComponent(recording.id)}`;
    if (
      server.upgrade(request, {
        data: {
          upstream,
          ownerUserId: actor.id,
          botId: streamBotId,
          ...(recording ? { recordingId: recording.id } : {}),
        },
      })
    ) {
      return undefined;
    }
    return new Response("Expected a WebSocket upgrade.", { status: 400 });
  });
}

/**
 * Saves one step of the owner's recording that arrived on an upgraded live-screen socket.
 *
 * Bun runs WebSocket handlers outside the upgrade's frame (it does not carry AsyncLocalStorage
 * across), so the `runAsTenant` above has ended by the time a `demonstration.action` comes in. The
 * socket's `ownerUserId` is the person `handleComputerStreamUpgrade` signed in, and the recording is
 * theirs, so the step is saved in their frame: unframed it read as `system`, which cannot see the
 * owner's recording, and under the frame guard it throws (G01-E P4).
 */
export function captureInFrame(
  data: Pick<
    ComputerStreamSocketData,
    "ownerUserId" | "botId" | "recordingId"
  >,
  action: unknown,
  capture: (
    ownerUserId: string,
    botId: string,
    recordingId: string,
    action: unknown,
  ) => Promise<void>,
): Promise<void> {
  return runAsTenant(data.ownerUserId, () =>
    capture(data.ownerUserId, data.botId, data.recordingId ?? "", action),
  );
}
