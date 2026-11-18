import { connect } from "node:net";

/**
 * Whether anything can connect to `::1` on this machine.
 *
 * Binding it is not evidence: Windows accepts `Bun.serve({ hostname: "::1" })` and then refuses every
 * connection to that address with `EACCES`. Two suites ask for a real answer from `::1`, and with no
 * IPv6 loopback the honest result is "nothing can reach it here", not a red case that says nothing
 * about the code. The probe is the connection, never the listener.
 */
export async function ipv6LoopbackWorks(): Promise<boolean> {
  const server = Bun.serve({
    port: 0,
    hostname: "::1",
    fetch: () => new Response(""),
  });
  const port = server.port;
  try {
    if (port === undefined) return false;
    return await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "::1", port });
      socket.setTimeout(2_000, () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  } finally {
    server.stop(true);
  }
}
