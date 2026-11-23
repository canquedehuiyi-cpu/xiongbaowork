import {
  type ComputerGateway,
  ComputerUnavailableError,
} from "../computer/gateway";
import type { AppProbe } from "./evidence-gate";

/** What the probe asks of the computer gateway; the real one is `createComputerGateway`'s. */
export type AppProbeGateway = Pick<
  ComputerGateway,
  "machine" | "seatFor" | "forwardHttp"
>;

/** How long the whole probe (finding the seat included) may take. */
export const APP_PROBE_TIMEOUT_MS = 10_000;

/**
 * The evidence gate's probe for a delivered program: one GET of its first page through the gateway.
 *
 * A deployment whose commands land on a paired computer cannot be reached from the server, and a
 * computer that is off or unreachable cannot answer either: both come back `null`, which the card
 * shows as 未核实. Any other failure (nothing listening, a timeout) is 打不开.
 */
export function createAppProbe(
  gateway: AppProbeGateway,
  timeoutMs: number = APP_PROBE_TIMEOUT_MS,
): AppProbe {
  return async ({ tenantId, agentId, port, path }) => {
    if (gateway.machine() === "device") return null;
    const signal = AbortSignal.timeout(timeoutMs);
    const expired = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    expired.catch(() => undefined);
    try {
      const answer = await Promise.race([
        (async () => {
          const seat = await gateway.seatFor(agentId, tenantId);
          return gateway.forwardHttp(
            seat,
            {
              port,
              method: "GET",
              path,
              headers: new Headers(),
              body: null,
            },
            signal,
          );
        })(),
        expired,
      ]);
      await answer.body?.cancel().catch(() => undefined);
      // The computer answers 403 for a port that is not this Bot's or has nothing listening.
      return answer.status === 403
        ? { refused: "forbidden" }
        : { status: answer.status };
    } catch (error) {
      if (error instanceof ComputerUnavailableError) return null;
      return { refused: "unreachable" };
    }
  };
}
