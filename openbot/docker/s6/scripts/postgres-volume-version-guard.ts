#!/usr/local/bin/bun
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type BigIntStats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

type Phase = "init" | "start";
type VolumeState = "new" | "existing";

// This image still ships PostgreSQL 16. A different binary major requires a
// separately reviewed image/startup change, never an environment override here.
const binaryDirectory = "/usr/lib/postgresql/16/bin";
const versionBytes = Buffer.from("16\n");

function refuse(reason: string): never {
  throw new Error("postgres-volume-version: " + reason);
}

function inspect(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    return refuse("could not inspect the data volume; refusing to change it.");
  }
}

function unchanged(before: BigIntStats, after: BigIntStats | undefined): boolean {
  return Boolean(
    after &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.mode === after.mode &&
      before.nlink === after.nlink &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs,
  );
}

function inspectDataDirectory(data: string): BigIntStats | undefined {
  if (data === "/" || data !== resolve(data)) {
    refuse("the data directory must be a normalized absolute path.");
  }
  let path = "";
  let result: BigIntStats | undefined;
  for (const component of data.split("/").slice(1)) {
    path += "/" + component;
    result = inspect(path);
    if (!result) return undefined;
    if (result.isSymbolicLink() || !result.isDirectory()) {
      refuse("the data directory and its ancestors must be real directories.");
    }
  }
  return result;
}

export function checkPostgresVolumeVersion(
  data: string,
  binaries: string,
  phase: Phase,
): VolumeState {
  if (binaries !== binaryDirectory || (phase !== "init" && phase !== "start")) {
    refuse("unsupported binary directory or startup phase.");
  }
  const directory = inspectDataDirectory(data);
  const path = join(data, "PG_VERSION");
  const before = directory ? inspect(path) : undefined;
  if (!before) {
    if (phase !== "init") {
      refuse("PG_VERSION is missing; only initialization may accept a new volume.");
    }
    if (directory && readdirSync(data).length !== 0) {
      refuse("PG_VERSION is missing from a nonempty data directory.");
    }
    // Initialization must not overwrite preserved credentials from a lost or
    // incomplete cluster, even when its data directory is empty or absent.
    for (const name of ["pgpassword", "pgpassword-app"]) {
      if (inspect(join(dirname(data), name))) {
        refuse("cluster credentials exist without PG_VERSION; restore the volume.");
      }
    }
    const after = inspectDataDirectory(data);
    if (directory ? !unchanged(directory, after) : after !== undefined) {
      refuse("the data directory changed while it was checked.");
    }
    return "new";
  }
  if (!directory) refuse("the data directory disappeared during inspection.");
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size !== BigInt(versionBytes.length)
  ) {
    refuse("PG_VERSION must be one regular, single-link file containing exactly 16 LF.");
  }
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    refuse("this runtime cannot open PG_VERSION without following links.");
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !unchanged(before, opened)) {
      refuse("PG_VERSION changed before it could be read.");
    }
    const bytes = Buffer.alloc(versionBytes.length + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (
      count !== versionBytes.length ||
      !bytes.subarray(0, count).equals(versionBytes)
    ) {
      refuse("PG_VERSION does not match this image's PostgreSQL 16; migrate explicitly.");
    }
    if (
      !unchanged(opened, fstatSync(fd, { bigint: true })) ||
      !unchanged(opened, inspect(path)) ||
      !unchanged(directory, inspectDataDirectory(data))
    ) {
      refuse("the volume changed while its version was checked.");
    }
    return "existing";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

if (import.meta.main) {
  try {
    const [data, binaries, phase, ...extra] = process.argv.slice(2);
    if (
      !data ||
      !binaries ||
      (phase !== "init" && phase !== "start") ||
      extra.length !== 0
    ) {
      refuse("expected data directory, fixed binary directory, and init/start phase.");
    }
    checkPostgresVolumeVersion(data, binaries, phase);
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith("postgres-volume-version:")
        ? error.message
        : "postgres-volume-version: inspection failed; refusing to change the volume.",
    );
    process.exitCode = 1;
  }
}
