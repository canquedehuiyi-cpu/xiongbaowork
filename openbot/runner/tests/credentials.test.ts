import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileCredentialStore,
  deviceIdFor,
  type RunnerCredentials,
} from "../src/credentials";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const root = mkdtempSync(join(tmpdir(), "openbot-runner-credentials-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a new machine gets a UUID v4, a different one each time", () => {
  const first = deviceIdFor(null);
  const second = deviceIdFor(null);
  expect(first).toMatch(UUID_V4);
  expect(second).toMatch(UUID_V4);
  expect(first).not.toBe(second);
});

test("a machine paired before keeps the id it has, in the old format (D7)", () => {
  const stored = {
    deviceId: "surface-1a2b3c4d",
    token: "obot_dev_x",
    server: "https://bot.example.com",
  };
  expect(deviceIdFor(stored)).toBe("surface-1a2b3c4d");
});

test("the file store writes the same three fields as before, readable only by its owner", async () => {
  const path = join(root, "deeper", "runner-state.json");
  const store = createFileCredentialStore(path);
  expect(store.location).toBe(path);
  expect(await store.load()).toBeNull();

  const credentials: RunnerCredentials = {
    deviceId: "6f1c3a52-6a5e-4a37-9d43-6f6b7e0f2a10",
    token: "obot_dev_secret",
    server: "https://bot.example.com",
  };
  await store.save(credentials);
  expect(readFileSync(path, "utf8")).toBe(
    `${JSON.stringify(credentials, null, 2)}\n`,
  );
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(await createFileCredentialStore(path).load()).toEqual(credentials);
});

test("a state file written by the runner before the store existed loads unchanged", async () => {
  const path = join(root, "legacy-state.json");
  writeFileSync(
    path,
    '{\n  "deviceId": "old-host-0badf00d",\n  "token": "obot_dev_old",\n  "server": "http://127.0.0.1:3000"\n}\n',
    { mode: 0o600 },
  );
  expect(await createFileCredentialStore(path).load()).toEqual({
    deviceId: "old-host-0badf00d",
    token: "obot_dev_old",
    server: "http://127.0.0.1:3000",
  });
});

test("a file that is not a complete state reads as nothing stored, never as a partial identity", async () => {
  const broken = join(root, "broken.json");
  writeFileSync(broken, "{ not json");
  expect(await createFileCredentialStore(broken).load()).toBeNull();
  const partial = join(root, "partial.json");
  writeFileSync(partial, JSON.stringify({ deviceId: "x", server: "y" }));
  expect(await createFileCredentialStore(partial).load()).toBeNull();
});
