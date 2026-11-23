import { readFileSync } from "node:fs";

/**
 * Which programs listen on this machine, and whether one employee may be sent to a given port.
 *
 * WHY. The computer forwards a request to a program an employee started on 127.0.0.1. All employees
 * share one network namespace, so a port number alone says nothing about whose program answers it:
 * without this check one employee could read another's dev server, the computer's own API, or its
 * egress filter. The kernel's listening table names the owner (uid) of every listener, and that is what
 * is asked here, before the connection is made.
 */

/** Ports below this are the system's; the forwarder never reaches them. */
export const FORWARD_PORT_MIN = 1024;
export const FORWARD_PORT_MAX = 65535;

export type Listener = {
  port: number;
  uid: number;
  inode: string;
  /** Dotted IPv4, `::`, `::1`, `::ffff:a.b.c.d`, or `ipv6:<hex>` for any other IPv6 address. */
  address: string;
};

const LISTEN_STATE = "0A";

function ipv4(hex: string): string | null {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
  // The kernel prints the address as one host-order word, so on little-endian the bytes are reversed.
  const bytes = [6, 4, 2, 0].map((at) =>
    Number.parseInt(hex.slice(at, at + 2), 16),
  );
  return bytes.join(".");
}

function ipv6(hex: string): string | null {
  if (!/^[0-9A-Fa-f]{32}$/.test(hex)) return null;
  // Four host-order words; put each back into network byte order.
  const bytes: string[] = [];
  for (let word = 0; word < 4; word += 1) {
    const part = hex.slice(word * 8, word * 8 + 8);
    for (const at of [6, 4, 2, 0]) bytes.push(part.slice(at, at + 2));
  }
  const text = bytes.join("").toLowerCase();
  if (text === "0".repeat(32)) return "::";
  if (text === `${"0".repeat(31)}1`) return "::1";
  if (text.startsWith(`${"0".repeat(20)}ffff`)) {
    const v4 = ipv4(
      [
        text.slice(30, 32),
        text.slice(28, 30),
        text.slice(26, 28),
        text.slice(24, 26),
      ].join(""),
    );
    if (v4) return `::ffff:${v4}`;
  }
  return `ipv6:${text}`;
}

function addressOf(hex: string): string | null {
  return hex.length === 8 ? ipv4(hex) : ipv6(hex);
}

/**
 * The listening rows of `/proc/net/tcp` or `/proc/net/tcp6` (same columns). Anything that is not a
 * LISTEN row, or that does not parse, is left out.
 */
export function parseProcNetTcp(text: string): Listener[] {
  const rows: Listener[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[3]?.toUpperCase() !== LISTEN_STATE) continue;
    const [addressHex = "", portHex = ""] = (fields[1] ?? "").split(":");
    if (!/^[0-9A-Fa-f]{1,4}$/.test(portHex)) continue;
    const address = addressOf(addressHex);
    const uid = Number(fields[7]);
    if (address === null || !Number.isInteger(uid) || uid < 0) continue;
    rows.push({
      port: Number.parseInt(portHex, 16),
      uid,
      inode: fields[9] ?? "",
      address,
    });
  }
  return rows;
}

/** Where a connection to 127.0.0.1 can land: the loopback itself or any address. */
function reachesLoopback(address: string): boolean {
  return (
    address === "0.0.0.0" ||
    address === "::" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

export type ForwardVerdict =
  | "ok"
  | "out-of-range"
  | "no-listener"
  | "not-yours"
  | "self";

/**
 * May this employee be sent to this port?
 *
 * `uid` is the employee's own Linux user, or null on a computer the employees share, where only the
 * range, the computer's own ports and the presence of a listener can be asked. When several listeners
 * hold the port (reuse-port), every one of them must be the employee's: one stranger is enough to refuse.
 */
export function checkForwardPort(input: {
  port: number;
  uid: number | null;
  tables: string[];
  selfPorts: readonly number[];
}): ForwardVerdict {
  const { port, uid, tables, selfPorts } = input;
  if (
    !Number.isInteger(port) ||
    port < FORWARD_PORT_MIN ||
    port > FORWARD_PORT_MAX
  )
    return "out-of-range";
  if (selfPorts.includes(port)) return "self";
  const holders = tables
    .flatMap(parseProcNetTcp)
    .filter((row) => row.port === port && reachesLoopback(row.address));
  if (holders.length === 0) return "no-listener";
  if (uid !== null && holders.some((row) => row.uid !== uid))
    return "not-yours";
  return "ok";
}

/** The URL segment as a port: plain decimal digits only (no sign, hex, exponent or spaces), else NaN. */
export function parseForwardPort(segment: string): number {
  return /^[0-9]{1,5}$/.test(segment) ? Number(segment) : Number.NaN;
}

/** The kernel's listening tables, as text. A table that cannot be read counts as empty. */
export function readListenTables(): string[] {
  return ["/proc/net/tcp", "/proc/net/tcp6"].map((path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  });
}
