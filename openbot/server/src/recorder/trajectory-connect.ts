import type {
  CopilotRuntimeHooks,
  GetTrajectoryLearningContainerIds,
} from "@copilotkit/runtime/v2";
import { IntelligenceKnowingANewThread } from "@openbot/toolkit/copilotkit/agents";
import type { IntelligenceSettings } from "../config";
import type { IdentifyUser } from "../copilot";
import { capturePassOrigin } from "../intelligence-gateway-proxy";

/**
 * The Recorder's capture pass (`POST <base>/trajectory/:trajectoryId/connect`), answered by this
 * deployment itself.
 *
 * WHY NOT THE RUNTIME'S. `handleTrajectoryConnect` begins with `isIntelligenceRuntime(runtime)`, and
 * this runtime keeps its threads in the local runner (R0), so it answered every pass
 * `503 INTELLIGENCE_RUNTIME_REQUIRED` — with an Intelligence key configured too. A recording then
 * reached nobody's Learning space, and the "Teach a Bot" screen had nothing to show for it.
 *
 * So the pass is answered here, with the runtime's own contract: the same gate in front (a connected
 * browser's Recorder token, the first pass binding the trajectory to its person, every refusal
 * audited), the same identity (`identifyUser`, which answers a Recorder token on this route only),
 * and a client of the same class the runtime builds upstream, carrying the selector that puts the
 * trajectory into its person's own Learning space (`recorder/wiring.ts`). Only the recording goes to
 * Intelligence; conversations stay in the local thread store.
 *
 * The client is built once. Its constructor stores settings and opens nothing.
 */
export function createTrajectoryConnect(deps: {
  intelligence: IntelligenceSettings;
  gate: NonNullable<CopilotRuntimeHooks["onBeforeHandler"]>;
  selectLearningContainers: GetTrajectoryLearningContainerIds;
  identifyUser: IdentifyUser;
  /** For tests: the client the pass is joined through. */
  client?: Pick<IntelligenceKnowingANewThread, "ɵconnectTrajectory">;
}): (request: Request, trajectoryId: string) => Promise<Response> {
  const client =
    deps.client ??
    new IntelligenceKnowingANewThread({
      apiUrl: deps.intelligence.apiUrl,
      wsUrl: deps.intelligence.gatewayWsUrl,
      // Where the gateway's address is a path, the Recorder's pass is handed it whole on this
      // server's origin as the Recorder reached it (intelligence-gateway-proxy.ts).
      ownOrigin: capturePassOrigin,
      apiKey: deps.intelligence.apiKey,
      getTrajectoryLearningContainerIds: deps.selectLearningContainers,
    });

  return async (request, trajectoryId) => {
    try {
      await deps.gate({
        request,
        route: { method: "trajectory/connect", trajectoryId },
      } as Parameters<typeof deps.gate>[0]);
    } catch (refusal) {
      // The gate answers a refusal by throwing the response it wrote (and audited).
      if (refusal instanceof Response) return refusal;
      throw refusal;
    }

    let user: { id: string; name: string };
    try {
      user = await deps.identifyUser(request);
    } catch {
      return failure(
        "IDENTITY_REQUIRED",
        "Trajectory capture requires an identified user",
        401,
      );
    }

    try {
      const grant = await client.ɵconnectTrajectory({
        trajectoryId,
        user,
        signal: request.signal,
      });
      return Response.json(grant, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const known = connectionError(error);
      if (known) return failure(known.code, known.message, known.status);
      return failure(
        "CONNECTION_FAILED",
        "Could not connect to Intelligence",
        502,
      );
    }
  };
}

function failure(code: string, message: string, status: number): Response {
  return Response.json(
    { code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The runtime's `TrajectoryConnectionError`, which it does not export: its messages are the public
 * contract, already stripped of the platform's raw errors and the key (`trajectoryResponseError`).
 */
function connectionError(
  error: unknown,
): { code: string; message: string; status: number } | undefined {
  if (!(error instanceof Error) || error.name !== "TrajectoryConnectionError")
    return undefined;
  const { code, status } = error as Error & {
    code?: unknown;
    status?: unknown;
  };
  if (typeof code !== "string" || typeof status !== "number") return undefined;
  return { code, message: error.message, status };
}
