import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { electron } from "@better-auth/electron";
import { expo } from "@better-auth/expo";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { genericOAuth, okta } from "better-auth/plugins";
import { and, eq, sql } from "drizzle-orm";
import { createEnterpriseStore } from "../admin/settings-store";
import type { AuditEventInput, AuditStore } from "../audit";
import { recordPersonAuditEvent, recordPlatformAuditEvent } from "../audit";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import {
  accounts,
  scimConnectionBindings,
  scimGroupMembers,
  scimGroups,
  scimIdentityTombstones,
  scimProjectionGrants,
  scimSubjects,
  scimUsers,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../db/schema";
import { provisionTenant } from "../tenant/provisioning";
import { DOMAIN_REFUSAL_MESSAGE, emailDomainAllowed } from "./email-domain";
import { encryptSsoConfig } from "./encrypt-sso-config";
import { SIGN_OUT_UNFINISHED } from "./organization";
import { applyConfiguredAdmin, isConfiguredAdmin, seedRole } from "./roles";
import { recordProvisioned, scimOptions } from "./scim";
import { englishName } from "../brand";

/** Answered when a provider sign-in would join an unverified password account with the same address. */
export const LINK_REFUSAL_MESSAGE =
  "该邮箱已有一个未验证的密码账号，不能直接用第三方登录接管。请用密码登录，或联系管理员处理。";

/** What a person sees when SSO is required and they tried another way in. */
/** The native app's custom scheme (mobile/app.config.ts). */
const NATIVE_APP_ORIGIN = "openbotmobile://";

export const SSO_REQUIRED_MESSAGE =
  "This deployment requires signing in through your company's identity provider. Enter your work email to continue.";

/**
 * SSO-required mode, decided on every sign-in, account link and account creation.
 *
 * Better Auth's `validateUserInfo` is told how the identity arrived (`oauth` for Google, Microsoft
 * and Okta-by-OAuth; `sso-oidc` / `sso-saml` for a registered enterprise provider; `scim` for a
 * directory). While `sso_required` is on, only the last three are admitted.
 *
 * BREAK-GLASS: an address in INITIAL_ADMIN_EMAILS may still sign in another way, so a broken or
 * misconfigured identity provider cannot lock every administrator out. Each such sign-in is written
 * as `session.break_glass`. Fails closed: settings that cannot be read refuse the sign-in.
 */
export async function decideSignInMethod(input: {
  method: string;
  email: string | undefined;
  ssoRequired: () => Promise<boolean>;
  initialAdminEmails: readonly string[];
}): Promise<"allow" | "break_glass" | "refuse"> {
  if (["sso-oidc", "sso-saml", "scim"].includes(input.method)) return "allow";
  let required: boolean;
  try {
    required = await input.ssoRequired();
  } catch {
    required = true;
  }
  if (!required) return "allow";
  if (input.email && isConfiguredAdmin(input.email, input.initialAdminEmails)) {
    return "break_glass";
  }
  return "refuse";
}

/**
 * Write a row about a sign-in, and never let the writing of it stop one.
 *
 * These run inside Better Auth's own hooks, where a thrown error becomes a refused sign-in. A trail
 * that is briefly unavailable must not lock everybody out of the deployment, so the failure is
 * logged where an operator will see it and the sign-in continues.
 *
 * Every row says whose it is (G01). `person` is the user id of the account Better Auth itself
 * resolved (a session's `userId`), and the row goes in that person's trail. Without one — a refusal
 * before any account is proven, keyed only on the address somebody typed — the row is the
 * deployment's, `platform`. Unframed, these were all `system`, so every tenant's trail listed every
 * refused sign-in in the deployment, address included.
 */
async function record(
  auditStore: AuditStore | undefined,
  event: AuditEventInput,
  person?: string,
): Promise<void> {
  if (!auditStore) return;
  try {
    if (person === undefined) await recordPlatformAuditEvent(auditStore, event);
    else await recordPersonAuditEvent(auditStore, person, event);
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "sign-in-audit-write-failed",
        eventType: event.eventType,
        error: String(error),
      }),
    );
  }
}

export async function stampSignIn(
  database: Database,
  userId: string,
  at: Date,
): Promise<void> {
  try {
    await database
      .update(users)
      .set({
        lastSignedInAt: sql`greatest(coalesce(${users.lastSignedInAt}, ${at}), ${at})`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "sign-in-stamp-write-failed",
        userId,
        error: String(error),
      }),
    );
  }
}

/**
 * An address for somebody arriving from Entra, whatever claim it turned up in.
 *
 * Entra does not always send `email`. Microsoft return it only when the profile carries an email
 * attribute, and for a multi-tenant application optional claims may not arrive at all, because an
 * external user's token is minted by their own tenant and does not inherit this application's claim
 * configuration. `common`, the default tenant here, is multi-tenant.
 *
 * Better Auth maps `email` straight through with no fallback, so on those deployments it is
 * undefined. That matters more here than in most products: every authorization decision OpenBot
 * makes about a person is keyed on their address. `INITIAL_ADMIN_EMAILS`, the role, the deny list
 * and the People screen all read it, so an absent address is not a cosmetic gap. Somebody would
 * sign in successfully, match no administrator, and land as a plain user with nothing on any screen
 * explaining why.
 *
 * `upn` first because it is the directory's own name for the account, then `preferred_username`,
 * which the OIDC spec explicitly does not promise is an address but which Entra populates with the
 * UPN in practice. Returning nothing when neither is present is deliberate: Better Auth then
 * refuses the sign-in, and being refused is a far better answer than being quietly admitted as
 * somebody the deployment cannot recognise.
 */
export function mapEntraProfile(profile: Record<string, unknown>) {
  const claim = (name: string) => {
    const value = profile[name];
    return typeof value === "string" && value.includes("@") ? value : undefined;
  };

  const email = claim("email") ?? claim("upn") ?? claim("preferred_username");
  if (!email) {
    console.error(
      JSON.stringify({
        type: "entra-profile-missing-email",
        note: "Entra returned no email, upn or preferred_username claim, so this person cannot be identified. Add `email` as an optional claim on the app registration, or use a single-tenant MICROSOFT_OAUTH_TENANT_ID.",
        claims: Object.keys(profile),
      }),
    );
    return {};
  }

  return { email };
}

export function createAuth(
  config: DeploymentConfig,
  database: Database,
  /**
   * Whether an administrator has removed this address.
   *
   * Checked here rather than only in the request guard, because a removed person whose sign-in
   * still succeeds gets a session, a user row and a place in the list: the removal would read as
   * having worked while quietly not having.
   */
  isRevoked?: (email: string) => Promise<boolean>,
  /**
   * Where getting in, and being turned away, are written down.
   *
   * Sign-in was the one thing this deployment did that left no trace. Two questions could not be
   * answered at all: who granted themselves the administrator role by editing the configuration, and
   * whether a person somebody has just removed had ever been here, because removing them deletes the
   * sessions that were the only evidence.
   *
   * Optional and never fatal. A trail that is unavailable must not stop somebody signing in, so every
   * write below is guarded and its failure is logged rather than raised.
   */
  auditStore?: AuditStore,
  options: {
    /**
     * Ends what else a person is signed in with here (their Recorder connections, index.ts) whenever their sign-in ends:
     * before a sign-out, and before any live session of theirs is deleted. Throws when it could not, and then the
     * session is not ended either: see `endRecordersOrRefuse`.
     */
    signOutRecorders?: (userId: string, ending: string) => Promise<void>;
    /**
     * Whether `auth/entra.ts` has just verified this Entra token, for the one sign-in it starts with
     * one: somebody arriving from their app's token whom OpenBot has not seen before.
     *
     * Better Auth's own check of a Microsoft token cannot pass against Entra's real keys, which
     * publish no `alg`, so its id-token sign-in is answered here instead. Only a token verified a
     * moment ago on that path passes: `/sign-in/social` with a token from anywhere else is refused,
     * as it always has been.
     */
    vouchesForMicrosoftToken?: (token: string) => boolean;
  } = {},
) {
  const authConfig = config.auth;
  if (!authConfig) {
    throw new Error("No identity provider is configured.");
  }

  /*
   * Okta goes through the generic OAuth plugin, the other two do not.
   *
   * Google and Entra are named providers that Better Auth knows the endpoints of. Okta is not one
   * place: every customer has their own issuer, so it is OIDC discovery against a URL rather than a
   * provider with a fixed address. The plugin is only registered when Okta is configured, so a
   * deployment that does not use it carries no extra routes.
   *
   * They converge again at the browser: `signIn.social({ provider })` starts every one of them, so
   * the sign-in screen has one code path and does not need to know which kind each provider is.
   */
  const scimDeps = {
    database,
    initialAdminEmails: authConfig.initialAdminEmails,
    ...(auditStore ? { auditStore } : {}),
  };
  const scimPluginOptions = scimOptions(scimDeps);
  const enterpriseStore = createEnterpriseStore(database);

  /**
   * Does this request come through the password form?
   *
   * `validateUserInfo`, which is where the SSO-required rule normally lives, is only called for
   * provider identities — Better Auth's own option type says as much ("Non-provider returning
   * sign-ins are not re-validated"). A password sign-up or sign-in never reaches it, so the rule has
   * to be re-applied on these two paths or switching SSO-required on would leave the side door open
   * now that email and password are enabled.
   */
  const isPasswordPath = (context: { path?: string } | null) =>
    context?.path === "/sign-up/email" || context?.path === "/sign-in/email";

  /**
   * Refuse a password sign-in that an SSO-required deployment does not admit.
   *
   * The same answer, and the same trail, as the OAuth path gives: an address named in
   * INITIAL_ADMIN_EMAILS still gets in (break-glass, recorded), and anybody else is refused and
   * recorded. Fails closed for the same reason `decideSignInMethod` does.
   */
  const refusePasswordSignInUnderSso = async (
    email: string | undefined,
    action: "sign-up" | "sign-in",
  ): Promise<void> => {
    const verdict = await decideSignInMethod({
      method: "password",
      email,
      ssoRequired: async () => (await enterpriseStore.settings()).ssoRequired,
      initialAdminEmails: authConfig.initialAdminEmails,
    });
    if (verdict === "allow") return;

    if (verdict === "break_glass") {
      await record(auditStore, {
        eventType: "session.break_glass",
        targetType: "person",
        payload: {
          email,
          provider: "password",
          action,
          reason:
            "SSO is required, and this address is named in INITIAL_ADMIN_EMAILS, so it was let in with a password",
        },
      });
      return;
    }

    await record(auditStore, {
      eventType: "session.refused",
      targetType: "person",
      payload: {
        email,
        provider: "password",
        action,
        reason: "SSO is required on this deployment",
      },
    });
    throw new APIError("FORBIDDEN", { message: SSO_REQUIRED_MESSAGE });
  };

  /*
   * The native app signs in through its custom scheme, and the Expo plugin appends the session cookie
   * to that redirect. Any Android app can register the same scheme, so the scheme is trusted only on
   * a deployment that runs the native app (EXPO_PROJECT_ID, as for push). Elsewhere a sign-in can
   * never be sent there.
   */
  const nativeApp = Boolean(process.env.EXPO_PROJECT_ID?.trim());
  const plugins = [
    ...(nativeApp ? [expo()] : []),
    /*
     * SCIM 2.0 at /api/auth/scim/v2, only when SCIM_BEARER_TOKEN is set. See scim.ts.
     */
    ...(scimPluginOptions ? [scim(scimPluginOptions)] : []),
    electron({ clientID: "openbot-desktop", codeExpiresIn: 120 }),
    ...(authConfig.okta
      ? [
          genericOAuth({
            config: [
              okta({
                clientId: authConfig.okta.clientId,
                clientSecret: authConfig.okta.clientSecret,
                issuer: authConfig.okta.issuer,
              }),
            ],
          }),
        ]
      : []),
    /*
     * Identity providers a company registers while this is running, by SAML or OIDC.
     *
     * Always on, unlike the three above, because it has nothing to configure: what it can do
     * depends entirely on what an administrator has registered, and an empty table means it offers
     * nothing. Turning it on and off would only mean a deployment could hold a registered IdP that
     * silently stopped working.
     *
     * `provisionUser` runs when somebody arrives through one of them. Their role has to be written
     * here or they land with no role at all and the request guard refuses them with a 403, which
     * reads as a broken deployment rather than a first sign-in.
     *
     * Only a role, never the administrator one: this hook can run for a row that already existed
     * and was linked to, which may hold a password somebody else set. A listed address is promoted
     * by `applyConfiguredAdmin` at the session instead, which checks that and trusts an identity
     * provider an administrator registered even when SAML reports no verified flag.
     */
    sso({
      provisionUser: async ({ user }) => {
        await seedRole(
          database,
          user.id,
          user.email,
          false,
          authConfig.initialAdminEmails,
        );
      },
    }),
  ];

  /*
   * Providers whose address the configured administrator list may trust without a verified flag.
   *
   * Entra omits `email_verified` by default, so on an Entra-only deployment the list would otherwise
   * promote nobody and leave nobody able to promote anyone. A single-tenant directory is the
   * deployment's own, so its address is its administrator's word; `common`, `organizations` and
   * `consumers` admit any tenant, whose administrator can write any address, so they are not.
   * Providers registered through the SSO plugin are trusted in `applyConfiguredAdmin` itself.
   */
  const microsoftTenant = authConfig.microsoft?.tenantId.trim().toLowerCase();
  const addressVouchingProviders: string[] =
    microsoftTenant &&
    !["common", "organizations", "consumers"].includes(microsoftTenant)
      ? ["microsoft"]
      : [];

  /*
   * A person's sessions and their Recorder connections end together or not at all. They are one sign-in, and ending
   * access here is never reported done while half of it stands: a removal ends sessions and deny-lists in one
   * transaction (people/store.ts), a removed person's linked accounts are retired in one transaction with their rows
   * (identity/retire.ts), and a connection ends exactly when its row is written (recorder/connections.ts). So when the
   * Recorders cannot be ended (signOutRecorders has retried and written `recorder.sign_out_failed`), the session is
   * left as it is and whoever was ending it is told: the person stays signed in and can sign out again. Answering
   * success would have left a Recorder recording as somebody who believes they signed out, for as long as it is used.
   */
  const endRecordersOrRefuse = async (userId: string, ending: string) => {
    if (!options.signOutRecorders) return;
    try {
      await options.signOutRecorders(userId, ending);
    } catch {
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: SIGN_OUT_UNFINISHED,
      });
    }
  };

  return betterAuth({
    /*
     * A sign-out ends the Recorders before Better Auth ends the session, here rather than in the session's delete hook
     * below: the sign-out route goes on when deleting the session throws (it logs, clears the cookie and answers
     * success), so only a refusal made before it starts reaches the person. The session is the one the route itself
     * would end, found the way it finds it (the signed cookie, then the row, expired or not).
     */
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path !== "/sign-out" || !options.signOutRecorders) return;
        const token = await context.getSignedCookie(
          context.context.authCookies.sessionToken.name,
          context.context.secret,
        );
        if (!token) return;
        const found = await context.context.internalAdapter.findSession(token);
        if (found)
          await endRecordersOrRefuse(found.session.userId, "/sign-out");
      }),
    },
    user: {
      additionalFields: {
        preferences: {
          type: "json",
          required: false,
          // Settings validates and patches this field for both SSO and single-user mode.
          input: false,
        },
        /*
         * Directory groups, written by SCIM's projection (scim.ts) and read by the per-group
         * capability switches and network policies. Never accepted from a sign-in request.
         */
        groups: {
          type: "string[]",
          required: false,
          input: false,
        },
      },
      validateUserInfo: async ({ user, source }) => {
        const verdict = await decideSignInMethod({
          method: source.method,
          email: typeof user.email === "string" ? user.email : undefined,
          ssoRequired: async () =>
            (await enterpriseStore.settings()).ssoRequired,
          initialAdminEmails: authConfig.initialAdminEmails,
        });
        if (verdict === "allow") return;
        const provider = source.oauth?.providerId ?? source.method;
        if (verdict === "break_glass") {
          await record(auditStore, {
            eventType: "session.break_glass",
            targetType: "person",
            payload: {
              email: user.email,
              provider,
              action: source.action,
              reason:
                "SSO is required, and this address is named in INITIAL_ADMIN_EMAILS, so it was let in another way",
            },
          });
          return;
        }
        await record(auditStore, {
          eventType: "session.refused",
          targetType: "person",
          payload: {
            email: user.email,
            provider,
            reason: "SSO is required on this deployment",
          },
        });
        return {
          error: "sso_required",
          errorDescription: SSO_REQUIRED_MESSAGE,
        };
      },
    },
    baseURL: authConfig.baseUrl,
    secret: authConfig.secret,
    trustedOrigins: [
      ...authConfig.trustedOrigins,
      ...(nativeApp ? [NATIVE_APP_ORIGIN] : []),
    ],
    /*
     * Wrapped, so a company's client secret is ciphertext in the column.
     *
     * The SSO plugin writes `oidc_config` and `saml_config` as plaintext JSON, and the client secret
     * for a customer's directory is inside them. Every other secret this deployment keeps goes
     * through `KEY_ENCRYPTION_KEY`; these two were the exception. See encrypt-sso-config.ts.
     */
    database: encryptSsoConfig(
      drizzleAdapter(database, {
        provider: "pg",
        usePlural: true,
        schema: {
          users,
          sessions,
          accounts,
          verifications,
          ssoProviders,
          scimConnectionBindings,
          scimIdentityTombstones,
          scimSubjects,
          scimUsers,
          scimProjectionGrants,
          scimGroups,
          scimGroupMembers,
        },
        // The SCIM plugin needs interactive transactions; nothing else here asked for them.
        transaction: Boolean(scimPluginOptions),
      }),
      config.keyEncryptionKey,
    ),
    account: {
      /*
       * The provider's access and refresh tokens, encrypted at rest.
       *
       * Better Auth's own mechanism, which uses `BETTER_AUTH_SECRET` rather than
       * `KEY_ENCRYPTION_KEY`. Deliberately theirs: it encrypts on the way into storage and decrypts
       * on the way out, in the one place that knows every path a token takes, and hand-rolling that
       * inside somebody else's storage layer is how rows become permanently unreadable. It also
       * tolerates the plaintext already in the column, so switching it on does not invalidate the
       * accounts of everybody who has already signed in.
       */
      encryptOAuthTokens: true,
    },
    /*
     * Email and password, on top of whatever providers this deployment has.
     *
     * The fork's own front door (ticket 004): a self-serve tenant arrives with nothing but an address
     * and a password, and the `user.create` hook below gives them a Free subscription and a 分身 the
     * same way an OAuth arrival does. Upstream OpenBot never had this path, which is why everything
     * here assumes a provider vouched for the address first — see the SSO-required refusal inside the
     * create hook, which is what keeps `ssoRequired` a wall rather than a suggestion once this is on.
     *
     * Better Auth 1.7's option is `emailAndPassword`, and it is a top-level option rather than a
     * plugin: the routes (`/api/auth/sign-up/email`, `/sign-in/email`) are then served by
     * `auth.handler`, so `app.ts` needs no new mounting.
     */
    emailAndPassword: { enabled: true },
    plugins,
    socialProviders: {
      ...(authConfig.google ? { google: authConfig.google } : {}),
      ...(authConfig.microsoft
        ? {
            microsoft: {
              clientId: authConfig.microsoft.clientId,
              clientSecret: authConfig.microsoft.clientSecret,
              tenantId: authConfig.microsoft.tenantId,
              mapProfileToUser: mapEntraProfile,
              verifyIdToken: async (token: string) =>
                options.vouchesForMicrosoftToken?.(token) ?? false,
            },
          }
        : {}),
      /*
       * GitHub, as Google is: a named provider with fixed endpoints and nothing to map.
       *
       * Better Auth asks GitHub for `user:email` and takes `emailVerified` from GitHub's own
       * `verified` flag on that address (false when GitHub does not vouch for it). It is not added to
       * any trusted-provider list, so an unverified GitHub address is never linked onto an existing
       * account. Nor is a verified one linked onto a row whose own address is unverified, which is
       * every password sign-up: Better Auth's `requireLocalEmailVerified` is on by default and is not
       * turned off here. Both refusals are generic to every social provider, not GitHub's own.
       */
      ...(authConfig.github ? { github: authConfig.github } : {}),
    },
    databaseHooks: {
      account: {
        create: {
          /*
           * Refuse to attach a provider to a row somebody else may hold the password to.
           *
           * Better Auth links a provider that reports a verified address onto the existing row with
           * that address. Sign-up does not verify email, so the row may have been registered with
           * a password by whoever typed the address first; linking would hand the real person's
           * provider sign-in the squatter's account and leave the squatter's password working. A
           * row whose address nobody verified and which holds a password is therefore not joined:
           * the person signs in with the password they set, or an administrator removes the row.
           */
          before: async (account) => {
            if (account.providerId === "credential") return;
            const [holder] = await database
              .select({
                email: users.email,
                emailVerified: users.emailVerified,
              })
              .from(users)
              .where(eq(users.id, account.userId))
              .limit(1);
            if (!holder || holder.emailVerified === true) return;
            const [password] = await database
              .select({ id: accounts.id })
              .from(accounts)
              .where(
                and(
                  eq(accounts.userId, account.userId),
                  eq(accounts.providerId, "credential"),
                ),
              )
              .limit(1);
            if (!password) return;
            await record(auditStore, {
              eventType: "session.refused",
              targetType: "person",
              targetId: account.userId,
              payload: {
                email: holder.email,
                provider: account.providerId,
                reason:
                  "an unverified password account already holds this address; the provider was not linked to it",
              },
            });
            throw new APIError("FORBIDDEN", {
              message: LINK_REFUSAL_MESSAGE,
            });
          },
        },
      },
      user: {
        create: {
          /*
           * Refuse before the account exists.
           *
           * Somebody removed and then signing in again would otherwise arrive as a brand-new person
           * with a fresh id, no role and no memory of having been removed, which is why the deny
           * list is keyed on the address rather than the id.
           */
          before: async (user, context) => {
            /*
             * Asked before the deny list because it needs no query, and before the account exists
             * because an address this deployment does not admit must not leave a user row behind.
             */
            if (
              !emailDomainAllowed(user.email, authConfig.allowedEmailDomains)
            ) {
              await record(auditStore, {
                eventType: "session.refused",
                targetType: "person",
                payload: {
                  email: user.email,
                  reason: "email domain not admitted by this deployment",
                },
              });
              throw new APIError("FORBIDDEN", {
                message: DOMAIN_REFUSAL_MESSAGE,
              });
            }
            /*
             * And before the row is written, so an SSO-required deployment gains no password account
             * to be locked out of later. Skipped for a provider, whose arrival already answered this
             * in `validateUserInfo`.
             */
            if (isPasswordPath(context)) {
              await refusePasswordSignInUnderSso(user.email, "sign-up");
            }
            if (await isRevoked?.(user.email)) {
              // The row a removed person coming back produces. Nothing else records the attempt:
              // no user row is written and no session exists to look at afterwards.
              await record(auditStore, {
                eventType: "session.refused",
                targetType: "person",
                payload: {
                  email: user.email,
                  reason: "access removed by an administrator",
                },
              });
              throw new APIError("FORBIDDEN", {
                message: `Your access to ${englishName()} has been removed.`,
              });
            }
            return { data: user };
          },
          after: async (user, context) => {
            /*
             * Who is an administrator is decided by email, not by which provider signed them in. A
             * deployment mid-migration has the same person arriving through Entra one week and
             * Okta the next, and they are the same person to this list. Only a verified address
             * counts: a password sign-up is unverified, so naming its address grants nothing.
             */
            await seedRole(
              database,
              user.id,
              user.email,
              user.emailVerified === true,
              authConfig.initialAdminEmails,
            );
            // Every arrival path gets its tenant: a Free subscription and its 分身.
            await provisionTenant(database, user, { withStaffing: true });
            if (context?.path?.startsWith("/scim")) {
              await recordProvisioned(scimDeps, user);
            }
          },
        },
      },
      session: {
        create: {
          /*
           * And again for somebody who already has an account. The user hook above only fires for a
           * new one, so without this a removed person signs straight back in.
           */
          before: async (session, context) => {
            const [user] = await database
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);
            /*
             * And again for an account that already exists, for the reason the deny list is checked
             * twice: the user hook fires only for a new one, so a domain later removed from the
             * list would otherwise keep admitting everybody who had already signed in once.
             */
            if (
              user &&
              !emailDomainAllowed(user.email, authConfig.allowedEmailDomains)
            ) {
              await record(
                auditStore,
                {
                  eventType: "session.refused",
                  targetType: "person",
                  targetId: session.userId,
                  actorUserId: session.userId,
                  payload: {
                    email: user.email,
                    reason: "email domain not admitted by this deployment",
                  },
                },
                session.userId,
              );
              throw new APIError("FORBIDDEN", {
                message: DOMAIN_REFUSAL_MESSAGE,
              });
            }
            if (user && (await isRevoked?.(user.email))) {
              await record(
                auditStore,
                {
                  eventType: "session.refused",
                  targetType: "person",
                  targetId: session.userId,
                  actorUserId: session.userId,
                  payload: {
                    email: user.email,
                    reason: "access removed by an administrator",
                  },
                },
                session.userId,
              );
              throw new APIError("FORBIDDEN", {
                message: `Your access to ${englishName()} has been removed.`,
              });
            }
            /*
             * The password sign-in of somebody who already had an account.
             *
             * Only this path, and only here: the account was created before an administrator switched
             * SSO on, so nothing else would notice. A provider's session already passed
             * `validateUserInfo`, and `isPasswordPath` is what keeps this from re-asking.
             */
            if (isPasswordPath(context)) {
              await refusePasswordSignInUnderSso(user?.email, "sign-in");
            }
            return { data: session };
          },
          after: async (session) => {
            await stampSignIn(database, session.userId, session.createdAt);

            /*
             * The configured floor, re-applied on every sign-in. Editing the list has to mean
             * something for people already in the table, or adding yourself after you first signed
             * in silently does nothing. Only promotes, and only verified addresses the list names:
             * everybody else's role belongs to the admin screen.
             */
            const promoted = await applyConfiguredAdmin(
              database,
              session.userId,
              authConfig.initialAdminEmails,
              addressVouchingProviders,
            );

            const [user] = await database
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);

            /*
             * The promotion, on the trail.
             *
             * The floor is applied silently by design, which meant anybody who could edit
             * `INITIAL_ADMIN_EMAILS` made themselves an administrator and nothing anywhere said so.
             * Written only when the role actually changed, so a returning administrator does not
             * produce one of these on every sign-in.
             */
            if (promoted) {
              await record(
                auditStore,
                {
                  eventType: "person.admin_by_configuration",
                  targetType: "person",
                  targetId: session.userId,
                  actorUserId: session.userId,
                  payload: {
                    email: user?.email,
                    reason:
                      "this address is named in INITIAL_ADMIN_EMAILS, so the configuration granted it",
                  },
                },
                session.userId,
              );
            }

            await record(
              auditStore,
              {
                eventType: "session.signed_in",
                targetType: "person",
                targetId: session.userId,
                actorUserId: session.userId,
                payload: { email: user?.email },
              },
              session.userId,
            );
          },
        },
        delete: {
          /*
           * Every other way a live session ends: signing out everywhere (`/revoke-sessions`), ending one session or
           * all the others (`/revoke-session`, `/revoke-other-sessions`), a password reset or change that signs out
           * other sessions, the directory deactivating the person (SCIM), the identity provider's single logout,
           * another account proving the address. Better Auth deletes sessions through this hook on every one of them.
           * Before the delete, so a refusal leaves the session where it was and the caller is told. Not a sign-out,
           * whose Recorders ended in the hook above, and not a session Better Auth finds expired and tidies away:
           * nobody ended that one, and a Recorder lasts its own lifetime.
           */
          before: async (session, context) => {
            if (context?.path === "/sign-out") return;
            if (new Date(session.expiresAt).getTime() <= Date.now()) return;
            await endRecordersOrRefuse(
              session.userId,
              context?.path ?? "sessions-ended",
            );
          },
        },
      },
    },
  });
}

/**
 * How long a session here lasts unused, in milliseconds: Better Auth's `session.expiresIn` as this instance resolved it.
 * OpenBot sets none, so it is Better Auth's own default, and it is read rather than restated so the two cannot drift.
 * Better Auth moves a session's expiry to this long from now whenever it is used (at most once per `updateAge`).
 */
export async function sessionLifetimeMs(
  auth: ReturnType<typeof createAuth>,
): Promise<number> {
  return (await auth.$context).sessionConfig.expiresIn * 1_000;
}
