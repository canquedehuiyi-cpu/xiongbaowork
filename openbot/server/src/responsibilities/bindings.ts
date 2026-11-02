import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  type CredentialSecretReader,
  type CredentialStore,
  openCredential,
  sealCredential,
} from "../credentials";
import type { Database } from "../db/client";
import { responsibilitySourceBindings } from "../db/schema/responsibilities";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
} from "./types";

export function createResponsibilityBindingStore(
  database: Database,
  vault: {
    store: CredentialStore;
    reader: CredentialSecretReader;
    encryptionKey: string;
  },
) {
  const safeColumns = {
    id: responsibilitySourceBindings.id,
    source: responsibilitySourceBindings.source,
    repository: responsibilitySourceBindings.repository,
    createdAt: responsibilitySourceBindings.createdAt,
  };
  return {
    list: (ownerUserId: string) =>
      database
        .select(safeColumns)
        .from(responsibilitySourceBindings)
        .where(eq(responsibilitySourceBindings.ownerUserId, ownerUserId)),
    async create(
      ownerUserId: string,
      input: { repository: string; secret: string },
    ) {
      const repository = input.repository.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.length > 256)
        throw new ResponsibilityRefusedError(
          "Use the GitHub repository owner/name.",
        );
      if (!input.secret.trim() || input.secret.length > 4096)
        throw new ResponsibilityRefusedError(
          "Supply a webhook secret of 1–4096 characters.",
        );
      const id = randomUUID();
      const { secret } = input;
      return database.transaction(async (transaction) => {
        const credential = await vault.store.create(
          {
            kind: "connector",
            provider: "github-webhook",
            keyId: id,
            metadata: { ownerUserId },
            seal: (binding) =>
              sealCredential(vault.encryptionKey, binding, secret),
          },
          transaction,
        );
        const [binding] = await transaction
          .insert(responsibilitySourceBindings)
          .values({
            id,
            ownerUserId,
            source: "github",
            repository,
            credentialId: credential.id,
          })
          .returning(safeColumns);
        if (!binding)
          throw new Error("GitHub event binding creation returned no row.");
        return { ...binding, webhookPath: `/api/events/github/${id}` };
      });
    },
    async remove(ownerUserId: string, id: string) {
      await database.transaction(async (transaction) => {
        const [binding] = await transaction
          .select()
          .from(responsibilitySourceBindings)
          .where(
            and(
              eq(responsibilitySourceBindings.id, id),
              eq(responsibilitySourceBindings.ownerUserId, ownerUserId),
            ),
          )
          .for("update");
        if (!binding) throw new ResponsibilityNotFoundError();
        await vault.store.revoke(binding.credentialId, transaction);
        await transaction
          .delete(responsibilitySourceBindings)
          .where(eq(responsibilitySourceBindings.id, id));
      });
    },
    async githubBindingFor(id: string) {
      const [binding] = await database
        .select()
        .from(responsibilitySourceBindings)
        .where(eq(responsibilitySourceBindings.id, id));
      if (!binding) return null;
      const credential = await vault.reader.readSecret(binding.credentialId);
      if (!credential || credential.revokedAt) return null;
      return {
        tenantId: binding.tenantId,
        ownerUserId: binding.ownerUserId,
        repository: binding.repository,
        // v2 since audit #9 (this store seals for the row); rows written before it are v1.
        secret: await openCredential(vault.encryptionKey, credential),
      };
    },
  };
}
export type ResponsibilityBindingStore = ReturnType<
  typeof createResponsibilityBindingStore
>;
