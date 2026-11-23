import type { ComputerGateway } from "../computer/gateway";

/** Asks the employee's computer what is at a workspace path (`ComputerGateway.statFile`). */
export type FileProbe = (input: {
  tenantId: string;
  agentId: string;
  path: string;
}) => ReturnType<ComputerGateway["statFile"]>;

/** How many paths are checked at the same time. */
const PROBE_CONCURRENCY = 4;

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
      } catch {
        answers[index] = null;
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
