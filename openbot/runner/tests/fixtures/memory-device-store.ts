/**
 * The parts of the server's device store that the register route and the runner socket handlers
 * call, kept in memory.
 *
 * Shared by `runner-package.test.ts` and `scripts/ci/sidecar-browser-probe.ts`: both start a compiled
 * runner against the server's own runner routes, and only the store is replaced, because Postgres is
 * not what either of them proves.
 */
import { createHash, randomBytes } from "node:crypto";
import type {
  DeviceOwner,
  DeviceRecord,
  DeviceStore,
} from "../../../server/src/devices/store";

export function memoryDeviceStore() {
  const codes = new Map<string, string>();
  const devices = new Map<
    string,
    DeviceRecord & { tenantId: string; tokenHash: string }
  >();
  const hash = (token: string) =>
    createHash("sha256").update(token).digest("hex");
  const byToken = (token: string) =>
    [...devices.values()].find((device) => device.tokenHash === hash(token));
  const ownerOf = (
    device: DeviceRecord & { tenantId: string; tokenHash: string },
  ): DeviceOwner => ({
    id: device.id,
    tenantId: device.tenantId,
    deviceId: device.deviceId,
    credentialVersion: device.tokenHash,
  });

  const store: DeviceStore = {
    async mintPairCode(tenantId) {
      const code = randomBytes(4).toString("hex").toUpperCase();
      codes.set(code, tenantId);
      return { code, expiresAt: new Date(Date.now() + 600_000) };
    },
    async redeemPairCode(input) {
      const tenantId = codes.get(input.code);
      if (!tenantId) return null;
      codes.delete(input.code);
      const token = `obot_dev_${randomBytes(24).toString("hex")}`;
      const device = {
        id: crypto.randomUUID(),
        tenantId,
        deviceId: input.deviceId,
        name: input.name,
        platform: input.platform,
        lastSeenAt: null,
        online: false,
        // The read-only folders the machine offers (F1 stage 2); a fresh pairing offers none.
        roots: [],
        // The local apps (MCP) it offers; a fresh pairing offers none.
        apps: [],
        tokenHash: hash(token),
      };
      devices.set(`${tenantId}/${input.deviceId}`, device);
      return { token, device };
    },
    async list(tenantId) {
      return [...devices.values()].filter((d) => d.tenantId === tenantId);
    },
    async tenantForCode(code) {
      return codes.get(code) ?? null;
    },
    async deviceForToken(token) {
      const device = byToken(token);
      return device ? ownerOf(device) : null;
    },
    async isCurrent(owner) {
      const device = devices.get(`${owner.tenantId}/${owner.deviceId}`);
      return device?.tokenHash === owner.credentialVersion;
    },
    async isRegistered(target, credentialVersion) {
      const device = devices.get(`${target.tenantId}/${target.deviceId}`);
      return Boolean(
        device &&
          (!credentialVersion || device.tokenHash === credentialVersion),
      );
    },
    async heartbeat(tenantId, deviceId) {
      const device = devices.get(`${tenantId}/${deviceId}`);
      if (device) device.lastSeenAt = new Date();
    },
    // Enabling an app writes it on the device record; this probe enables none.
    async rememberApp() {},
    async remove(tenantId, id) {
      for (const [key, device] of devices) {
        if (device.tenantId === tenantId && device.id === id) {
          devices.delete(key);
          return true;
        }
      }
      return false;
    },
  };
  return { store, devices };
}
