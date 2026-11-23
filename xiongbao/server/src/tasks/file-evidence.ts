import type { ComputerGateway } from "../computer/gateway";

/** Asks the employee's computer what is at a workspace path (`ComputerGateway.statFile`). */
export type FileProbe = (input: {
  tenantId: string;
  agentId: string;
  path: string;
}) => ReturnType<ComputerGateway["statFile"]>;

/** How many paths are checked at the same time. */
const PROBE_CONCURRENCY = 4;

/** A short label for a probe failure: the error code or name, at most 60 characters. */
function errorLabel(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  const label =
    typeof code === "string" || typeof code === "number"
      ? String(code)
      : typeof name === "string"
        ? name
        : "unknown";
  return label.slice(0, 60);
}

/**
 * Whether the workspace files a hand-in names are really there, for the evidence gate.
 *
 * A path with nothing at it is `missing`; a file of zero bytes is `empty`; a folder counts as there.
 * A path the probe cannot answer for (a paired personal computer, or a computer that did not answer)
 * is `unverified`: shown as such on the card, not a reason to bounce the hand-in.
 */
export async function verifyWorkspaceFiles(input: {
  tenantId: string;
  agentId: string;
  paths: readonly string[];
  probe: FileProbe;
}): Promise<{
  failures: { path: string; reason: "missing" | "empty" }[];
  unverified: string[];
}> {
  const answers: Awaited<ReturnType<FileProbe>>[] = new Array(
    input.paths.length,
  ).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < input.paths.length) {
      const index = next++;
      try {
        answers[index] = await input.probe({
          tenantId: input.tenantId,
          agentId: input.agentId,
          path: input.paths[index] as string,
        });
      } catch (error) {
        answers[index] = null;
        console.warn(
          JSON.stringify({
            type: "file-evidence-unverified",
            agentId: input.agentId,
            path: input.paths[index],
            error: errorLabel(error),
          }),
        );
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PROBE_CONCURRENCY, input.paths.length) },
      worker,
    ),
  );
  const failures: { path: string; reason: "missing" | "empty" }[] = [];
  const unverified: string[] = [];
  input.paths.forEach((path, index) => {
    const answer = answers[index];
    if (answer === null || answer === undefined) unverified.push(path);
    else if (answer === "absent") failures.push({ path, reason: "missing" });
    else if (answer.kind === "file" && answer.bytes === 0)
      failures.push({ path, reason: "empty" });
  });
  return { failures, unverified };
}
