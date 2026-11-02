/**
 * The seam a payment channel would plug into (spec K3), reserved and deliberately empty.
 *
 * This product takes no payment yet: a plan moves because a platform administrator moved it. What is
 * fixed here is the shape a real channel would have to fit — a provider that answers "how does this
 * tenant get from one plan to another", and hooks that hear about a switch after it happened — so the
 * day one is added, the switch route, the plans page and the tests do not change shape with it.
 *
 * No SDK, no network, no secrets: the only provider that exists is the manual one.
 */

/** What a person asking to change plans is told to do next. */
export type CheckoutResult =
  | { kind: "manual"; instructions: string }
  | { kind: "redirect"; url: string };

export type CheckoutRequest = {
  tenantId: string;
  fromPlanId: string | null;
  toPlanId: string;
  actorId: string;
};

export type PaymentProvider = {
  /** Stable name, shown to the plans page and recorded on every plan change it is behind. */
  readonly id: string;
  /** Which arm `checkout` answers with, known without asking it (a read must not open a checkout). */
  readonly kind: CheckoutResult["kind"];
  /** What the plans page may say up front. Only the manual kind has something to say. */
  readonly instructions?: string;
  checkout: (request: CheckoutRequest) => Promise<CheckoutResult>;
};

/** A plan switch that has already been written. Hooks hear about it; they cannot veto it. */
export type PlanChangeEvent = {
  tenantId: string;
  fromPlanId: string | null;
  toPlanId: string;
  actorId: string;
  provider: string;
  at: Date;
};

export type PlanChangeHook = (event: PlanChangeEvent) => void | Promise<void>;

export const MANUAL_PAYMENT_PROVIDER_ID = "manual";
export const MANUAL_PAYMENT_INSTRUCTIONS = "由平台管理员切换套餐";

/** The only channel there is: no payment, a platform administrator moves the row. */
export function createManualPaymentProvider(): PaymentProvider {
  return {
    id: MANUAL_PAYMENT_PROVIDER_ID,
    kind: "manual",
    instructions: MANUAL_PAYMENT_INSTRUCTIONS,
    checkout: async () => ({
      kind: "manual",
      instructions: MANUAL_PAYMENT_INSTRUCTIONS,
    }),
  };
}

/**
 * The deployment's provider, from `OPENBOT_PAYMENT_PROVIDER`.
 *
 * Unset (or blank) and `manual` are the manual provider. Anything else is refused at boot rather than
 * quietly treated as manual: a deployment that names a channel expects to be charging through it, and
 * a server that starts anyway would hand out plans while its operator thinks they are being paid for.
 * The value itself is not echoed, because a misplaced key in the wrong variable is the likely typo.
 */
export function paymentProviderFromEnv(
  env: Record<string, string | undefined>,
): PaymentProvider {
  const configured = env.OPENBOT_PAYMENT_PROVIDER?.trim().toLowerCase() ?? "";
  if (configured === "" || configured === MANUAL_PAYMENT_PROVIDER_ID) {
    return createManualPaymentProvider();
  }
  throw new Error(
    'OPENBOT_PAYMENT_PROVIDER names a payment provider this build does not have. Only "manual" (or unset) is supported.',
  );
}

/**
 * Tell every hook about a switch that has already committed, one after another, in order.
 *
 * A hook that throws is logged and skipped; the switch stands and the next hook still runs. Only the
 * hook's position and the error's class are logged — never the thrown value or its message, which a
 * hook talking to an outside system could fill with a token or a customer's details.
 */
export async function runPlanChangeHooks(
  hooks: readonly PlanChangeHook[],
  event: PlanChangeEvent,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
  for (const [index, hook] of hooks.entries()) {
    try {
      await hook(event);
    } catch (error) {
      const kind =
        error instanceof Error ? error.constructor.name : typeof error;
      log(
        `[quota] plan change hook #${index} failed (${kind}); the plan switch stands.`,
      );
    }
  }
}
