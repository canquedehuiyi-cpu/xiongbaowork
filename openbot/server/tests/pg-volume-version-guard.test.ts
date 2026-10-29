import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPostgresVolumeVersion } from "../../docker/s6/scripts/postgres-volume-version-guard";

// These are shell/CPU boundary tests with temporary directories and command
// recorders. They never invoke PostgreSQL, Docker, migrations or real s6.
const helper = fileURLToPath(
  new URL("../../docker/s6/scripts/postgres-volume-version-guard.ts", import.meta.url),
);
const init = fileURLToPath(
  new URL("../../docker/s6/scripts/postgres-init.sh", import.meta.url),
);
const start = fileURLToPath(
  new URL("../../docker/s6/s6-rc.d/postgres/run", import.meta.url),
);
const binaries = "/usr/lib/postgresql/16/bin";
let root: string;
let volume: string;
let data: string;
let environment: string;
let commands: string;
let log: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pg-volume-version-guard-"));
  volume = join(root, "volume");
  data = join(volume, "data");
  environment = join(root, "environment");
  commands = join(root, "commands");
  log = join(root, "commands.log");
  for (const path of [data, environment, commands]) mkdirSync(path, { recursive: true });
  writeFileSync(join(environment, "MIGRATION_DATABASE_URL"), "unchanged-url");
  const recorder =
    '#!/bin/sh\nprintf "%s\\n" "$0" >> "$PG_GUARD_COMMAND_LOG"\nexit 97\n';
  for (const command of ["mkdir", "chown", "chmod", "od", "mktemp", "s6-setuidgid"]) {
    const path = join(commands, command);
    writeFileSync(path, recorder);
    chmodSync(path, 0o755);
  }
});

afterEach(() => {
  if (!root?.startsWith(join(tmpdir(), "pg-volume-version-guard-"))) {
    throw new Error("Refusing to remove an unexpected fixture directory.");
  }
  rmSync(root, { recursive: true, force: true });
});

function snapshot(path: string): unknown {
  if (!existsSync(path) && !isLink(path)) return null;
  const stat = lstatSync(path, { bigint: true });
  const metadata = {
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    mtime: stat.mtimeNs.toString(),
    ctime: stat.ctimeNs.toString(),
  };
  if (stat.isSymbolicLink()) return { ...metadata, link: readlinkSync(path) };
  if (stat.isDirectory()) {
    return {
      ...metadata,
      entries: readdirSync(path)
        .sort()
        .map((name) => [name, snapshot(join(path, name))]),
    };
  }
  return { ...metadata, content: readFileSync(path).toString("base64") };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function state(): unknown {
  return [snapshot(volume), snapshot(environment), snapshot(join(root, "target"))];
}

function quoteShell(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function runEntrypoint(entrypoint: "init" | "start") {
  const original = readFileSync(entrypoint === "init" ? init : start, "utf8");
  // Only relocate the image's fixed paths in a disposable copy. Production
  // callers have no environment switch for changing data, guard or binary major.
  const script = original
    .replaceAll("/var/lib/postgresql", volume)
    .replaceAll("/run/s6/container_environment", environment)
    .replaceAll("/usr/local/bin/bun", quoteShell(process.execPath))
    .replaceAll(
      "/etc/s6-overlay/scripts/postgres-volume-version-guard.ts",
      quoteShell(helper),
    );
  const path = join(root, entrypoint + ".sh");
  writeFileSync(path, script);
  return spawnSync("/bin/sh", [path], {
    env: {
      ...process.env,
      EMBEDDED_POSTGRES: "on",
      PATH: commands + ":" + (process.env.PATH ?? "/usr/bin:/bin"),
      PG_GUARD_COMMAND_LOG: log,
    },
    encoding: "utf8",
    timeout: 5_000,
  });
}

function header(value: string) {
  writeFileSync(join(data, "PG_VERSION"), value);
}

test("accepts only the exact existing PG16 header without changing the volume", () => {
  header("16\n");
  const before = state();
  expect(checkPostgresVolumeVersion(data, binaries, "init")).toBe("existing");
  expect(checkPostgresVolumeVersion(data, binaries, "start")).toBe("existing");
  expect(state()).toEqual(before);
});

test("a new empty or absent data directory is initialization-only", () => {
  const before = state();
  expect(checkPostgresVolumeVersion(data, binaries, "init")).toBe("new");
  expect(() => checkPostgresVolumeVersion(data, binaries, "start")).toThrow("missing");
  expect(state()).toEqual(before);
  rmSync(data, { recursive: true });
  const absent = state();
  expect(checkPostgresVolumeVersion(data, binaries, "init")).toBe("new");
  expect(() => checkPostgresVolumeVersion(data, binaries, "start")).toThrow("missing");
  expect(state()).toEqual(absent);
});

test("a different binary major cannot authorize conversion of a PG16 volume", () => {
  header("16\n");
  const before = state();
  expect(() =>
    checkPostgresVolumeVersion(data, "/usr/lib/postgresql/17/bin", "init"),
  ).toThrow("unsupported binary");
  expect(state()).toEqual(before);
});

const cases: Array<{ name: string; prepare: () => void }> = [
  { name: "PG17 cluster", prepare: () => header("17\n") },
  { name: "unknown major", prepare: () => header("99\n") },
  { name: "empty header", prepare: () => header("") },
  { name: "unterminated header", prepare: () => header("16") },
  { name: "extra line", prepare: () => header("16\n\n") },
  { name: "CRLF header", prepare: () => header("16\r\n") },
  {
    name: "header symlink",
    prepare: () => {
      writeFileSync(join(root, "target"), "16\n");
      symlinkSync(join(root, "target"), join(data, "PG_VERSION"));
    },
  },
  {
    name: "dangling header symlink",
    prepare: () => symlinkSync(join(root, "absent"), join(data, "PG_VERSION")),
  },
  { name: "header directory", prepare: () => mkdirSync(join(data, "PG_VERSION")) },
  {
    name: "data symlink",
    prepare: () => {
      rmSync(data, { recursive: true });
      mkdirSync(join(root, "target"));
      writeFileSync(join(root, "target", "PG_VERSION"), "16\n");
      symlinkSync(join(root, "target"), data);
    },
  },
  {
    name: "nonempty cluster without header",
    prepare: () => writeFileSync(join(data, "lost+found"), "preserve"),
  },
  {
    name: "preserved credentials without cluster",
    prepare: () => writeFileSync(join(volume, "pgpassword"), "preserve-owner"),
  },
];

for (const entrypoint of ["init", "start"] as const) {
  for (const item of cases) {
    test(entrypoint + " refuses " + item.name + " before any write or startup", () => {
      item.prepare();
      const before = state();
      const result = runEntrypoint(entrypoint);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("postgres-volume-version:");
      expect(existsSync(log)).toBe(false);
      expect(state()).toEqual(before);
    });
  }
}
