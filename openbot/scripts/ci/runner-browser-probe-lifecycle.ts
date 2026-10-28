/** Stop only this probe's own temporary Bun HTTP fixture and its connections. */
export async function stopRunnerProbeServer(
  server: { stop(closeActiveConnections?: boolean): unknown },
): Promise<void> {
  await server.stop(true);
}
