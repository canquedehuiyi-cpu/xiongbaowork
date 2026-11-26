import type { CredentialBinding } from "../../src/credentials";

/**
 * Credential envelopes as v0.2.15 sealed them, written out independently of the server's own code so
 * a test of the reader and of the v0.2.16 rekey is not the code under test agreeing with itself.
 *
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，the pre-v0.2.16 label below is the data the rekey
 * exists to find. It goes with the rekey.
 */
// legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
export const V0215_AAD_LABEL = "openbot.vault.credential.v2";
export const V0216_AAD_LABEL = "xiongbao.vault.credential.v2";

/** The additional data an envelope is bound to: length-prefixed UTF-8 frames of label and row. */
function additionalData(label: string, row: CredentialBinding) {
  return Buffer.concat(
    [label, row.tenantId, row.id, row.kind].flatMap((part) => {
      const bytes = Buffer.from(part, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.byteLength);
      return [length, bytes];
    }),
  );
}

async function aesKey(encoded: string) {
  return crypto.subtle.importKey(
    "raw",
    Buffer.from(encoded, "base64"),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A credential envelope exactly as v0.2.15 wrote one: kid `k1`, the pre-v0.2.16 label. */
export async function sealAsV0215(
  key: string,
  row: CredentialBinding,
  plaintext: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: additionalData(V0215_AAD_LABEL, row),
    },
    await aesKey(key),
    Buffer.from(plaintext, "utf8"),
  );
  return JSON.stringify({
    version: 2,
    alg: "A256GCM",
    bind: "credential",
    kid: "k1",
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  });
}

/** Opens a v2 envelope under one named label, whatever its kid says. */
export async function openUnder(
  label: string,
  key: string,
  row: CredentialBinding,
  envelope: string,
) {
  const parsed = JSON.parse(envelope) as { iv: string; ciphertext: string };
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(parsed.iv, "base64"),
      additionalData: additionalData(label, row),
    },
    await aesKey(key),
    Buffer.from(parsed.ciphertext, "base64"),
  );
  return Buffer.from(plaintext).toString("utf8");
}
