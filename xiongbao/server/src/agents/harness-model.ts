/**
 * Which remote Bots take XiongBao's model choice.
 *
 * A Bot on its own framework picks its own model, so the composer's picker is only offered where a
 * run's model is this deployment's to decide: a built-in Bot, and the harness picked in setup when it
 * is one of XiongBao's own images that reads `forwardedProps.xiongbaoModel` (the LangGraph harness,
 * which also serves the ChatGPT plan, and the Claude Agent SDK harness, which serves the Claude plan).
 * A harness somebody brought themselves is theirs, and is never told what to run on.
 */

/** XiongBao's own harness images that read `forwardedProps.xiongbaoModel`, by name or digest. */
const TAKES_MODEL =
  /(?:^|\/)(?:xiongbao-)?agent-(?:langgraph-agui|claude-sdk)(?::|@|$)/;

const trimmed = (url: string) => url.trim().replace(/\/+$/, "");

/** Whether the harness picked in setup is one of XiongBao's own that takes the model choice. */
export function pickedHarnessTakesModel(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (environment.PICKED_HARNESS_SOURCE?.trim() === "byo") return false;
  return TAKES_MODEL.test(environment.PICKED_HARNESS_IMAGE?.trim() ?? "");
}

/** Whether a Bot at this endpoint takes the model choice: only the picked harness, when it does. */
export function takesModelChoice(
  endpoint: string | null | undefined,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const picked = environment.PICKED_HARNESS_URL?.trim();
  if (!endpoint || !picked) return false;
  return (
    trimmed(endpoint) === trimmed(picked) &&
    pickedHarnessTakesModel(environment)
  );
}
