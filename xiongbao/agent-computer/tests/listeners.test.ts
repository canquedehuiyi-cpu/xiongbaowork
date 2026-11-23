import { describe, expect, test } from "bun:test";
import {
  checkForwardPort,
  FORWARD_PORT_MAX,
  FORWARD_PORT_MIN,
  parseForwardPort,
  parseProcNetTcp,
} from "../src/listeners";
import { botKeyOf, employeeUid } from "../src/per-bot";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

/** /proc/net/tcp: 8080 is uid 1000's, 3000 is uid 1001's; 5000 is an established connection, not a listener. */
const sample = `${HEADER}
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 22222 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1388 0100007F:A1B2 01 00000000:00000000 02:000A1B2C 00000000  1000        0 33333 2 0000000000000000 20 4 30 10 -1
`;

/** /proc/net/tcp6: ::1 on 4000 (uid 1000), :: on 4001 (uid 1001), ::ffff:127.0.0.1 on 4002 (uid 1000), a LAN address on 9000. */
const sample6 = `${HEADER}
   0: 00000000000000000000000001000000:0FA0 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:0FA1 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 55555 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:0FA2 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 66666 1 0000000000000000 100 0 0 10 0
   3: 0000000000000000FFFF00000201A8C0:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 77777 1 0000000000000000 100 0 0 10 0
   4: 00000000000000000000000001000000:0FA3 00000000000000000000000001000000:C350 01 00000000:00000000 00:00000000 00000000  1000        0 88888 1 0000000000000000 100 0 0 10 0
`;

/** IPv4 listener on a LAN address only (192.168.1.2:9001). */
const lanOnly = `${HEADER}
   0: 0201A8C0:2329 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000000000000000 100 0 0 10 0
`;

describe("parseProcNetTcp", () => {
  test("only LISTEN rows, with port, uid, inode and address", () => {
    const rows = parseProcNetTcp(sample);
    expect(rows.map((r) => r.port)).toEqual([8080, 3000]);
    expect(rows[0]).toEqual({
      port: 8080,
      uid: 1000,
      inode: "11111",
      address: "127.0.0.1",
    });
    expect(rows[1]?.address).toBe("0.0.0.0");
    expect(rows[1]?.uid).toBe(1001);
  });

  test("reads the tcp6 table, addresses included", () => {
    const rows = parseProcNetTcp(sample6);
    expect(rows.map((r) => [r.port, r.address])).toEqual([
      [4000, "::1"],
      [4001, "::"],
      [4002, "::ffff:127.0.0.1"],
      [9000, "::ffff:192.168.1.2"],
    ]);
  });

  test("garbage and empty text give nothing", () => {
    expect(parseProcNetTcp("")).toEqual([]);
    expect(parseProcNetTcp("not a table\n\n  0: zz:zz zz 0A x")).toEqual([]);
  });
});

describe("checkForwardPort", () => {
  const tables = [sample, sample6];
  const base = { tables, selfPorts: [3002] as number[] };

  test("another employee's listener is refused; own port is self", () => {
    expect(checkForwardPort({ ...base, port: 8080, uid: 1001 })).toBe(
      "not-yours",
    );
    expect(checkForwardPort({ ...base, port: 8080, uid: 1000 })).toBe("ok");
    expect(
      checkForwardPort({
        port: 3002,
        uid: 1000,
        tables: [sample],
        selfPorts: [3002],
      }),
    ).toBe("self");
  });

  test("a self port is refused even when a listener exists and the computer is shared", () => {
    const own = `${HEADER}\n   0: 0100007F:0BBA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  0        0 1 1 0\n`;
    expect(
      checkForwardPort({
        port: 3002,
        uid: null,
        tables: [own],
        selfPorts: [3002],
      }),
    ).toBe("self");
  });

  test("wildcard and every loopback spelling count as a listener", () => {
    expect(checkForwardPort({ ...base, port: 3000, uid: 1001 })).toBe("ok");
    expect(checkForwardPort({ ...base, port: 4000, uid: 1000 })).toBe("ok");
    expect(checkForwardPort({ ...base, port: 4001, uid: 1001 })).toBe("ok");
    expect(checkForwardPort({ ...base, port: 4002, uid: 1000 })).toBe("ok");
    expect(checkForwardPort({ ...base, port: 4001, uid: 1000 })).toBe(
      "not-yours",
    );
  });

  test("no listener: unknown port, established connection, LAN-only bind", () => {
    expect(checkForwardPort({ ...base, port: 7777, uid: 1000 })).toBe(
      "no-listener",
    );
    expect(checkForwardPort({ ...base, port: 5000, uid: 1000 })).toBe(
      "no-listener",
    );
    expect(checkForwardPort({ ...base, port: 4003, uid: 1000 })).toBe(
      "no-listener",
    );
    expect(checkForwardPort({ ...base, port: 9000, uid: 1000 })).toBe(
      "no-listener",
    );
    expect(
      checkForwardPort({
        port: 9001,
        uid: 1000,
        tables: [lanOnly],
        selfPorts: [],
      }),
    ).toBe("no-listener");
  });

  test("a shared computer (uid null) checks range, self and listener only", () => {
    expect(checkForwardPort({ ...base, port: 8080, uid: null })).toBe("ok");
    expect(checkForwardPort({ ...base, port: 7777, uid: null })).toBe(
      "no-listener",
    );
  });

  test("two listeners on one port: a stranger among them refuses", () => {
    const shared = `${HEADER}
   0: 0100007F:2710 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0
   1: 00000000:2710 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 2 1 0
`;
    expect(
      checkForwardPort({
        port: 10000,
        uid: 1000,
        tables: [shared],
        selfPorts: [],
      }),
    ).toBe("not-yours");
  });

  test.each([
    80,
    1023,
    65536,
    0,
    3.5,
    Number.NaN,
    -1,
    Number.POSITIVE_INFINITY,
  ])("port %p is out of range", (port) => {
    expect(
      checkForwardPort({ port, uid: 1, tables: [sample], selfPorts: [] }),
    ).toBe("out-of-range");
  });

  test("the range edges", () => {
    expect(FORWARD_PORT_MIN).toBe(1024);
    expect(FORWARD_PORT_MAX).toBe(65535);
  });
});

describe("parseForwardPort", () => {
  test.each(["8080", "1024", "65535", "09999"])(
    "%p is a decimal port",
    (text) => {
      expect(parseForwardPort(text)).toBe(Number(text));
    },
  );
  test.each([
    "+8080",
    "-8080",
    "0x1F90",
    "1e3",
    "80.5",
    "",
    " 8080",
    "8080 ",
    "123456",
    "８０８０",
    "8080/x",
  ])("%p is refused", (text) => {
    expect(Number.isNaN(parseForwardPort(text))).toBe(true);
  });
});

describe("employeeUid", () => {
  const key = botKeyOf("bot-a");
  const passwd = `root:x:0:0:root:/root:/bin/bash\nxb-${key}:x:1005:1005::/home:/bin/bash\nxb-other:x:1006:1006::/:/bin/sh\n`;
  test("finds xb-<botKey>", () => {
    expect(employeeUid("bot-a", { passwd })).toBe(1005);
  });
  test("null when there is no such user", () => {
    expect(employeeUid("bot-b", { passwd })).toBeNull();
    expect(employeeUid("bot-a", { passwd: "" })).toBeNull();
  });
});
