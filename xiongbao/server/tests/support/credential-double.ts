// server/tests/support/credential-double.ts
//
// A vault whose unused members are present and say so.
//
// WHY THIS EXISTS. `PluginStoreOptions.credentials` is `CredentialSecretReader & CredentialStore`,
// and that is deliberate — the store comment at `plugins/store.ts` argues why writing belongs on the
// same object as reading. So a test that injects a vault has to satisfy six write methods whether or
// not the case it is about ever writes anything. Writing them out per file produced stubs that were
// not just long but WRONG IN A WAY TYPE-CHECKING CANNOT SEE: `{ readSecret: async () => null }` was
// accepted as `any` for as long as the suite went unchecked, and at run time a call to any of the
// six was a `TypeError: credentials.create is not a function` with a stack pointing at the product
// rather than at the fixture that left the hole.
//
// A `Proxy` that answers every property would hide the same thing again. The defaults here THROW,
// and they throw naming the member and the fact that the test did not provide it — which is what an
// absent method effectively did, only it now says whose fault it is.
//
// `readSecret` is the exception, defaulting to "no such secret": almost every caller of this double
// wants "the vault is empty", and spelling that at eleven sites was the noise that made the other
// five members easy to forget.
import type {
  CredentialSecretReader,
  CredentialStatusReader,
  CredentialStore,
  ModelCredentialSecretReader,
} from "../../src/credentials";

/** Everything a vault is, across the four interfaces the server splits it into. */
type Vault = CredentialStore &
  CredentialSecretReader &
  CredentialStatusReader &
  ModelCredentialSecretReader;

/**
 * A member this test does not use. The function shape is dropped on purpose: `Promise<never>` is
 * assignable to every return type here, so one factory covers `create`, `revoke`, `list` and the
 * rest without restating nine signatures that must then be kept in step with `credentials.ts`.
 */
const unused = (member: string) => async (): Promise<never> => {
  throw new Error(
    `credentialDouble: the vault's \`${member}\` was called, and this test did not provide one.`,
  );
};

/** A vault for `PluginStoreOptions.credentials` and friends: empty, unless a member is overridden. */
export const credentialDouble = (overrides: Partial<Vault> = {}): Vault => ({
  create: unused("create"),
  updateSecret: unused("updateSecret"),
  rotate: unused("rotate"),
  revoke: unused("revoke"),
  isLive: unused("isLive"),
  findLiveByKey: unused("findLiveByKey"),
  readSecret: async () => null,
  list: async () => [],
  readModelSecret: async () => null,
  ...overrides,
});
