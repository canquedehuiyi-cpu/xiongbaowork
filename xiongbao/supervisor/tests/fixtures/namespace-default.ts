import { afterAll, afterEach, expect, test } from "bun:test";
import type Docker from "dockerode";
import {
  CONFIGURED_NAMESPACE,
  DEFAULT_NAMESPACE,
  LEGACY_DEFAULT_NAMESPACE,
  legacyLabel,
  NAMESPACE,
  NAMESPACE_LABEL,
  namesFor,
  OWNER_LABEL,
} from "../../src/names";

/*
 * Launched by docker.integration.test.ts in a fresh process WITHOUT COMPUTER_NAMESPACE, on a host the launcher found
 * holding no computer under either default namespace: a deployment that configured none settles its namespace from
 * the host. Every volume planted here carries this run's fixture label and is removed by it.
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
 */
if (CONFIGURED_NAMESPACE !== undefined)
  throw new Error("This fixture must run without COMPUTER_NAMESPACE.");

const run = `namespace-default-${crypto.randomUUID()}`;
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const { default: DockerClient } = await import("dockerode");
const docker: Docker = new DockerClient({ socketPath: SOCKET });
const supervisor = await import("../../src/docker");

let completedCases = 0;
let planted = 0;

async function plantVolume(labels: Record<string, string>) {
  planted += 1;
  await docker.createVolume({
    Name: `${run}-${planted}`,
    Labels: { ...labels, "xiongbao.test-fixture": run },
  });
}

async function removePlanted() {
  const { Volumes } = await docker.listVolumes({
    filters: { label: [`xiongbao.test-fixture=${run}`] },
  });
  for (const volume of Volumes ?? []) await docker.getVolume(volume.Name).remove();
}

afterEach(async () => {
  await removePlanted();
  supervisor.forgetNamespace();
  completedCases += 1;
});

afterAll(async () => {
  await removePlanted();
  console.log(
    `NAMESPACE_FIXTURE ${JSON.stringify({ completedCases, cleanup: "complete" })}`,
  );
});

test("a host with no computers takes the current default", async () => {
  expect(await supervisor.resolveNamespace()).toBe(DEFAULT_NAMESPACE);
  expect(NAMESPACE).toBe(DEFAULT_NAMESPACE);
});

test("a host with computers only from before v0.2.16 keeps their namespace, and names computers in it", async () => {
  // A volume from before the namespace label existed: it belongs to that day's default.
  await plantVolume({ [legacyLabel(OWNER_LABEL)]: "true" });
  expect(await supervisor.resolveNamespace()).toBe(LEGACY_DEFAULT_NAMESPACE);
  expect(NAMESPACE).toBe(LEGACY_DEFAULT_NAMESPACE);
  const names = namesFor("person", "ada");
  expect(names.ok && names.names.profileVolume).toBe(
    `${LEGACY_DEFAULT_NAMESPACE}-profile-person-ada`,
  );
});

test("a host that has computers under both defaults stays on the current one", async () => {
  await plantVolume({
    [legacyLabel(OWNER_LABEL)]: "true",
    [legacyLabel(NAMESPACE_LABEL)]: LEGACY_DEFAULT_NAMESPACE,
  });
  await plantVolume({
    [OWNER_LABEL]: "true",
    [NAMESPACE_LABEL]: DEFAULT_NAMESPACE,
  });
  expect(await supervisor.resolveNamespace()).toBe(DEFAULT_NAMESPACE);
});
