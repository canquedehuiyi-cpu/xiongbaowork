import {
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { shortName } from "@/lib/brand";
import { client } from "@/lib/client";

/**
 * What this deployment can do, as the server is willing to say it.
 *
 * A projection, not the runtime. `/api/capabilities` is reachable before anybody has signed in, so
 * only fields somebody may know unauthenticated appear on it; the Intelligence contract and every
 * deployment secret stay on the server. See server/src/app.ts.
 */
export type DeploymentCapabilities = {
  /**
   * Whether a Bot may answer with an interface it wrote itself.
   *
   * Read by the browser because the browser owns half of this capability: the SDK's provider is what
   * offers the model the tool that generates one. A deployment that turned the server half off while
   * the browser kept offering the tool would have Bots writing whole interfaces that nothing draws,
   * so both halves read this one answer.
   */
  generativeUi: boolean;
  /**
   * Whether the operator turned the support banner on (OPENBOT_SELF_HOST_BANNER=true; off by
   * default). The server answers false for a deployment on a paid Intelligence plan, and the banner
   * itself stays hidden without a tenant `supportUrl`.
   */
  selfHostBanner: boolean;
  /**
   * Whether this is somebody trying OpenBot on their own machine rather than an organization's
   * deployment: single-user mode on the server, which only a local, unreachable install can be in.
   */
  localEvaluation: boolean;
  /**
   * Which product this is. `personal` is one person on their own machine: no Admin, and what they
   * need of it under Settings. A server from before the switch reads as `team`.
   */
  edition: "team" | "personal";
  transcription?: boolean;
  voice?: boolean;
  /**
   * Whether a person's chat has its computer tools run by the server (期九): the page then only draws
   * them, and the turn goes on with the page closed. The browser declares the choice in each run, so
   * a server that does not say reads as off, and the page runs its own tools as it always did.
   */
  chatServerComputerTools?: boolean;
  /**
   * Whether this deployment has memory. Both editions do, and the personal one stops having it when its
   * operator sets `XIONGBAO_PERSONAL_MEMORY=off`. A server from before this field says nothing, and
   * {@link offersMemory} then reads the edition as it used to: no memory in the personal one.
   */
  memory?: boolean;
  /**
   * Whether the server pushes the task board's card changes over the channel socket (pilot,
   * `XIONGBAO_PILOT_BOARD_PUSH`). Absent from a server that does not say, which reads as off.
   */
  boardPush?: boolean;
  /**
   * Whether the inbox lets a person write notes on what waits there and send them back to the
   * conversation (pilot, `XIONGBAO_PILOT_INBOX_NOTES`). Absent from a server that does not say, which
   * reads as off.
   */
  inboxNotes?: boolean;
};

export const deploymentKeys = {
  all: ["deployment"] as const,
  capabilities: () => ["deployment", "capabilities"] as const,
};

/**
 * What this deployment can do.
 *
 * From the server rather than from the build, like the sign-in options beside it: the container image
 * is built once and knows nothing about the deployment that will run it, so a capability compiled
 * into the bundle can only ever describe the build machine.
 *
 * Absent fields read as off. A server too old to answer, or one that failed to, is a server this app
 * should not assume a capability of — and for generated interfaces the fail-closed direction is the
 * safe one, because claiming it wrongly is what makes a Bot generate something nothing renders.
 */
export function deploymentCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: deploymentKeys.capabilities(),
    // Configuration, not data. It cannot change without the process restarting.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<DeploymentCapabilities> => {
      /*
       * The whole body, then one field off it. `/api/capabilities` answers with a bare object rather
       * than the envelope most endpoints use, which is why this reads the Response itself instead of
       * naming a key — the same shape the sign-in query uses.
       */
      const body = (await (
        await client("/api/capabilities", {
          fallback: `读不到${shortName()}能做什么。`,
        })
      ).json()) as {
        generativeUi?: boolean;
        selfHostBanner?: boolean;
        localEvaluation?: boolean;
        edition?: string;
        transcription?: boolean;
        voice?: boolean;
        chatServerComputerTools?: boolean;
        memory?: boolean;
        boardPush?: boolean;
        inboxNotes?: boolean;
      };

      return {
        generativeUi: body.generativeUi === true,
        selfHostBanner: body.selfHostBanner === true,
        localEvaluation: body.localEvaluation === true,
        edition: body.edition === "personal" ? "personal" : "team",
        transcription: body.transcription === true,
        voice: body.voice === true,
        chatServerComputerTools: body.chatServerComputerTools === true,
        ...(typeof body.memory === "boolean" ? { memory: body.memory } : {}),
        ...(body.boardPush === true ? { boardPush: true } : {}),
        ...(body.inboxNotes === true ? { inboxNotes: true } : {}),
      };
    },
  });
}

/** Whether the inbox draws notes (pilot). False until the deployment says so, so nothing flashes in. */
export function useInboxNotesEnabled(): boolean {
  return (
    useQuery(deploymentCapabilitiesQueryOptions()).data?.inboxNotes === true
  );
}

/**
 * Whether this deployment offers memory: what a person's Bots remember about them, and the apps a
 * Bot learns it from. Every memory screen, row and link reads this.
 *
 * Both editions have memory, and the personal one stops having it only when its operator turns it off
 * (`XIONGBAO_PERSONAL_MEMORY=off`). The server says which in `memory`, read from the same rule that
 * decides its memory tools, routes and sweep (`editionHasMemory`), not from the back end's
 * entitlement: that answer only chooses where memory is kept (the back end, or the app's own tables)
 * and changes from one minute to the next while the back end starts, so a screen gated on it would come
 * and go.
 *
 * A server that does not say (one from before the field) is read as before: no memory in the personal
 * edition. An edition that could not be read is the team edition, as everywhere else.
 */
export function offersMemory(
  capabilities: Pick<DeploymentCapabilities, "edition" | "memory"> | undefined,
): boolean {
  return capabilities?.memory ?? capabilities?.edition !== "personal";
}

/**
 * {@link offersMemory} for a component. False until the edition is known, so the personal edition
 * never draws a memory row for a moment or asks the server for memory it doesn't have.
 */
export function useOffersMemory(): boolean {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  return !capabilities.isPending && offersMemory(capabilities.data);
}

/** {@link offersMemory} for a route guard, which has the query client and no component. */
export async function deploymentOffersMemory(
  queryClient: QueryClient,
): Promise<boolean> {
  return offersMemory(
    await queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined),
  );
}
