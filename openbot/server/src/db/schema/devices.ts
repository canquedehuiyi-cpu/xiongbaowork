import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId } from "./tenant";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A tenant's own machine, running a coworker's hands.
 *
 * The device is a tenant fact rather than a deployment one because that is the product: work runs
 * where the person lives, not on the server that schedules it, and nothing about a tenant's desktop
 * belongs to anybody else's.
 */
export const registeredDevices = pgTable(
  "registered_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    /**
     * The machine's own stable identifier, minted by the runner and kept on disk.
     *
     * Unique per tenant rather than globally: two people may run a runner on the same prebuilt image
     * and share an identifier, and neither is thereby looking at the other's machine.
     */
    deviceId: text("device_id").notNull(),
    name: text("name").notNull(),
    /** Whatever the runner says it is (`win32`, `darwin`): shown, never decided on. */
    platform: text("platform"),
    /**
     * Hash of the bearer token the runner connects with, never the token.
     *
     * A database dump would otherwise be a set of working credentials for every machine in the
     * deployment, and a device token is not a small one: it lets its holder receive the work a
     * coworker is told to do on that person's desktop.
     */
    tokenHash: text("token_hash").notNull(),
    /**
     * The last moment this device said it was alive.
     *
     * Presence is READ from this rather than stored beside it: a status column is a second answer to
     * one question, and the two disagree the first time a machine is switched off at the wall. A
     * device that has not been heard from in `OFFLINE_AFTER_MS` is offline, and no close event,
     * restart or lost packet is needed for that to become true.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("registered_devices_tenant_device_idx").on(
      table.tenantId,
      table.deviceId,
    ),
    index("registered_devices_tenant_idx").on(table.tenantId),
  ],
);

/** How long a device may be silent before the screen calls it offline. */
export const OFFLINE_AFTER_MS = 60_000;

/**
 * A one-time code that turns a machine into a device.
 *
 * The pairing is the only thing standing between a stranger and "run my coworker's tool calls on my
 * desktop", so the code is short, single-use and short-lived, and it is minted by a signed-in person
 * looking at their own screen. The runner never carries a password, and no route accepts one.
 */
export const devicePairCodes = pgTable(
  "device_pair_codes",
  {
    code: text("code").primaryKey(),
    tenantId: tenantId(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** When it was spent. A spent code is refused rather than reusable — this is a credential. */
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
    /** The device this code admitted, kept so a spent code still explains the machine it made. */
    deviceId: text("device_id"),
  },
  (table) => [
    index("device_pair_codes_tenant_idx").on(table.tenantId),
    index("device_pair_codes_expires_idx").on(table.expiresAt),
  ],
);
