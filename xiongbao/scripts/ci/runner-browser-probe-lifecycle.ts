/** Stop only this probe's own temporary Bun HTTP fixture and its connections. */
export async function stopRunnerProbeServer(
  server: { stop(closeActiveConnections?: boolean): unknown },
): Promise<void> {
  await server.stop(true);
}

/**
 * Remove the probe's disposable directory without ever replacing the probe's real failure.
 * Windows keeps a just-closed Chrome's profile files locked for a moment (EBUSY), so the removal
 * retries; if it still fails it is reported on stderr and the caller's own error stays the one thrown.
 */
export function removeRunnerProbeRoot(
  path: string,
  remove: (
    path: string,
    options: { recursive: boolean; force: boolean; maxRetries: number; retryDelay: number },
  ) => void,
  report: (message: string) => void = (message) => console.error(message),
): void {
  try {
    remove(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    report(
      `could not remove the probe directory ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
