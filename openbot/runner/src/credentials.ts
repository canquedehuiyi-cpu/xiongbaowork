import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What a paired machine keeps between runs: who it is, the token it was given, and where it was paired.
 *
 * The token is the only secret here. The device id and the server are not, but they are kept with it
 * because they are only meaningful together: a token is answered for one device id on one deployment.
 */
export type RunnerCredentials = {
  deviceId: string;
  token: string;
  server: string;
};

/**
 * Where those credentials live. Replaceable on purpose (F2 stage 0).
 *
 * The command-line runner keeps them in a file only its owner can read. A desktop shell that wraps the
 * runner will want the operating system's keychain instead, and that is a different store with the
 * same two questions, not a different runner. Both answers are asynchronous because a keychain's are.
 */
export type CredentialStore = {
  /** Shown in log lines, so a person can find what was written. Never the secret itself. */
  readonly location: string;
  /** Null when nothing usable is stored yet: this run needs a pairing. */
  load: () => Promise<RunnerCredentials | null>;
  save: (credentials: RunnerCredentials) => Promise<void>;
};

/**
 * The default store: `runner-state.json`, mode 0600.
 *
 * The format is the one every paired runner already has on disk, `{ deviceId, token, server }`, and
 * stays exactly that, so a machine paired before this file existed loads and connects unchanged.
 */
export function createFileCredentialStore(path: string): CredentialStore {
  return {
    location: path,
    async load() {
      try {
        const parsed = JSON.parse(
          readFileSync(path, "utf8"),
        ) as Partial<RunnerCredentials>;
        if (
          typeof parsed.deviceId === "string" &&
          typeof parsed.token === "string" &&
          typeof parsed.server === "string"
        ) {
          return {
            deviceId: parsed.deviceId,
            token: parsed.token,
            server: parsed.server,
          };
        }
      } catch {
        // No file, or one that is not ours yet. Either way, this run needs a pairing.
      }
      return null;
    },
    /** The device token is a credential, so the file holding it is not world-readable. */
    async save(credentials) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, {
        mode: 0o600,
      });
      try {
        chmodSync(path, 0o600);
      } catch {
        // A filesystem without modes still got a file it created private.
      }
    },
  };
}

/**
 * This machine's stable id.
 *
 * A new machine gets a random UUID (v4) and keeps it in its credentials, so restarting does not grow
 * the owner's device list and two laptops with the same hostname are still two devices. The hostname
 * is not part of it any more: the human-readable name travels separately, as `--name`.
 *
 * A machine paired earlier keeps the id it has (`hostname-xxxxxxxx`). The server stores device ids as
 * opaque text and its token is answered for the id it was paired with, so a new id would mean pairing
 * again and a second entry on the owner's list. The old format is read and used exactly as stored
 * (F2 decision D7).
 */
export function deviceIdFor(stored: RunnerCredentials | null): string {
  return stored?.deviceId ?? randomUUID();
}
