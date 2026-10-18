import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  providerName,
  signInWith,
  signInWithEmail,
  signInWithEmailDomain,
  signUpWithEmail,
} from "@/lib/auth/client";
import { appConfig } from "@/lib/generated/application-config";
import { queryClient } from "@/query-client";
import {
  type AuthProviderId,
  authKeys,
  authProvidersQueryOptions,
  currentUserQueryOptions,
} from "../lib/auth/queries";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

/** Better Auth's own minimum for a password, asked here so it is refused by the form, not a 400. */
const MIN_PASSWORD_LENGTH = 8;

/** Which half of the password card is showing. */
type PasswordMode = "sign-in" | "sign-up";

export const Route = createFileRoute("/sign")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user) {
      throw redirect({ to: "/" });
    }
    // Loaded here so the screen paints with its buttons rather than painting empty and then
    // growing them, which reads as "no providers" for exactly as long as the request takes.
    await context.queryClient.ensureQueryData(authProvidersQueryOptions());
  },
  component: SignScreen,
});

function SignScreen() {
  // Which provider is being opened, rather than whether one is: with three buttons, a single
  // boolean would put "Opening…" on all of them.
  const [opening, setOpening] = useState<AuthProviderId | "sso" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: options } = useQuery(authProvidersQueryOptions());
  const providers = options?.providers ?? [];
  const [email, setEmail] = useState("");
  const navigate = useNavigate();

  /*
   * The password card's own fields, not the ones the company-address box above uses.
   *
   * The two ask for an address for different reasons — one to choose a provider, one to name an
   * account — and sharing a field would mean either typing it twice for the wrong reason or watching
   * what somebody typed into one form appear in the other.
   */
  const [mode, setMode] = useState<PasswordMode>("sign-in");
  const [accountName, setAccountName] = useState("");
  const [passwordEmail, setPasswordEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  /**
   * Sign in through whichever identity provider covers this address.
   *
   * No password is asked for and none is checked here: only the part after the @ is used, to decide
   * which registered provider to hand somebody to.
   */
  async function handleDomainSignIn(submission: React.FormEvent) {
    submission.preventDefault();
    setError(null);
    setOpening("sso");

    try {
      await signInWithEmailDomain(email);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "那个地址没有登记任何身份提供方。",
      );
      setOpening(null);
    }
  }

  async function handleSignIn(provider: AuthProviderId) {
    setError(null);
    setOpening(provider);

    try {
      await signInWith(provider);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `无法开始 ${providerName(provider)} 登录。`,
      );
      setOpening(null);
    }
  }

  /**
   * Sign in, or create the account and sign into it in the same breath.
   *
   * Both end the same way because Better Auth's `autoSignIn` answers a successful sign-up with a
   * session: registering does not need a second pass through the form.
   *
   * The navigation is the part no other way in on this screen does. A provider sends the browser away
   * and brings it back with a session already in place, so the route guard has never answered for this
   * person yet. Here the session arrives under a page that has already asked that question and been
   * told nobody is signed in — so that answer is dropped before the guard is asked again, which is
   * also what sends somebody who has not finished onboarding to /onboarding rather than to the
   * workbench.
   */
  async function handlePasswordSubmit(submission: React.FormEvent) {
    submission.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (mode === "sign-up") {
        await signUpWithEmail({
          name: accountName.trim(),
          email: passwordEmail.trim(),
          password,
        });
      } else {
        await signInWithEmail(passwordEmail.trim(), password);
      }
      queryClient.removeQueries({ queryKey: authKeys.all });
      await navigate({ to: "/" });
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : mode === "sign-up"
            ? "未能创建账户。"
            : "未能登录。",
      );
      setSubmitting(false);
    }
  }

  /** The card is submit-worthy once the fields its own mode asks for are filled in. */
  const passwordReady =
    password.length >= MIN_PASSWORD_LENGTH &&
    passwordEmail.trim().length > 0 &&
    (mode === "sign-in" || accountName.trim().length > 0);

  const passwordFields = (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        {(["sign-in", "sign-up"] as const).map((each) => (
          <Button
            className="flex-1 tracking-tight"
            // Toggling is how a person gets out of a refusal they caused on the other half, so the
            // message goes with the mode rather than lingering over a different form.
            key={each}
            onClick={() => {
              setMode(each);
              setError(null);
            }}
            size="sm"
            type="button"
            variant={mode === each ? "secondary" : "ghost"}
          >
            {each === "sign-in" ? "登录" : "注册"}
          </Button>
        ))}
      </div>
      {mode === "sign-up" ? (
        <Input
          autoComplete="name"
          onChange={(event) => setAccountName(event.target.value)}
          placeholder="你的名字"
          required
          value={accountName}
        />
      ) : null}
      <Input
        autoComplete="email"
        onChange={(event) => setPasswordEmail(event.target.value)}
        placeholder="you@example.com"
        required
        type="email"
        value={passwordEmail}
      />
      <Input
        // `new-password` rather than `current-password` on the registration half, which is what tells
        // a password manager to offer a strong one instead of filling in an old answer.
        autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
        minLength={mode === "sign-up" ? MIN_PASSWORD_LENGTH : undefined}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="密码"
        required
        type="password"
        value={password}
      />
      <Button
        className="h-10 w-full tracking-tight"
        disabled={!passwordReady || submitting}
        size="lg"
        type="submit"
        variant="outline"
      >
        {submitting ? "请稍候…" : mode === "sign-up" ? "创建我的账户" : "登录"}
      </Button>
    </div>
  );

  const providerButtons = (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        /*
         * Every provider gets the same button, and it is the light-themed outline one
         * rather than the app's filled primary. Google's guidelines require their button be
         * at least as prominent as any other sign-in option and specify its fill and
         * stroke, so making one provider the loud one would break that for the others. The
         * same size and weight throughout is also the honest presentation: a deployment
         * that configured three has three, and none of them is the recommended one.
         */
        <Button
          className="h-10 w-full justify-start gap-3 px-3 tracking-tight"
          disabled={opening !== null}
          key={provider}
          onClick={() => handleSignIn(provider)}
          size="lg"
          variant="outline"
        >
          <ProviderLogo provider={provider} />
          {/* Centred against the button, not against the space left of the mark. */}
          <span className="flex-1 text-center">
            {opening === provider
              ? `正在打开 ${providerName(provider)}…`
              : `使用 ${providerName(provider)} 继续`}
          </span>
          {/* Balances the mark so the label sits in the middle of the button. */}
          <span aria-hidden="true" className="size-[18px]" />
        </Button>
      ))}
    </div>
  );

  const prefersReducedMotion = useReducedMotion();
  const hidden = {
    opacity: 0,
    ...(prefersReducedMotion ? {} : { transform: ENTRANCE_OFFSET }),
  };
  const shown = {
    opacity: 1,
    ...(prefersReducedMotion ? {} : { transform: "translateY(0px)" }),
  };

  return (
    <div className="flex flex-col h-dvh w-full items-center justify-center -mt-12">
      <motion.div
        animate="shown"
        className="flex-1 flex w-full max-w-82 flex-col items-center justify-center p-4"
        initial="hidden"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS } },
        }}
      >
        <motion.div
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
          className="flex items-center justify-center"
        >
          <AgentOrb size="56px" />
        </motion.div>
        <motion.h1
          className="text-2xl font-medium tracking-tight text-center mt-8"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          登录 {appConfig.brand.productName}
        </motion.h1>
        <motion.div
          className="mt-8 w-full"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {options?.ssoRequired ? (
            <p className="mb-3 text-center text-sm text-muted-foreground">
              你的组织要求使用单点登录。
            </p>
          ) : null}
          {providers.length > 0 && !options?.ssoRequired ? (
            providerButtons
          ) : options?.sso ||
            options?.ssoRequired ||
            options?.emailPassword ? null : (
            <p className="text-center text-sm text-muted-foreground">
              这个部署没有配置任何登录方式。
            </p>
          )}
          {/*
           * An address and a password: the way in for a person no provider covers, and the way a
           * tenant is created at all — the server's `user.create` hook gives whoever registers a Free
           * subscription and a 分身 before the screen below them has finished loading.
           *
           * Kept out of sight when an administrator requires single sign-on, because that is exactly
           * when the server refuses a password (see the auth hooks' `isPasswordPath` guard). Offering
           * it there would be a form whose only answer is "your organization requires single sign-on".
           */}
          {options?.emailPassword && !options?.ssoRequired ? (
            <form className="mt-3" onSubmit={handlePasswordSubmit}>
              {providers.length > 0 ? (
                <div className="mb-3 flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-muted-foreground text-xs">或</span>
                  <Separator className="flex-1" />
                </div>
              ) : null}
              {passwordFields}
            </form>
          ) : null}
          {/*
           * The way in for a company that runs its own identity provider.
           *
           * Below the buttons, because a deployment with both has more people arriving through the
           * buttons: the registered providers are for the companies whose IdP was added by hand.
           */}
          {options?.sso ? (
            <form className="mt-3" onSubmit={handleDomainSignIn}>
              {providers.length > 0 ? (
                <div className="mb-3 flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-muted-foreground text-xs">或</span>
                  <Separator className="flex-1" />
                </div>
              ) : null}
              <Input
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                required
                type="email"
                value={email}
              />
              <Button
                className="mt-2 h-10 w-full tracking-tight"
                disabled={opening !== null || email.trim().length === 0}
                size="lg"
                type="submit"
                variant="outline"
              >
                {opening === "sso" ? "正在打开…" : "使用企业账户继续"}
              </Button>
            </form>
          ) : null}
          {/* The administrators' audited break-glass while SSO is required; everybody else is refused. */}
          {options?.ssoRequired && providers.length > 0 ? (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-center text-muted-foreground">
                管理员登录
              </summary>
              <div className="mt-3">{providerButtons}</div>
            </details>
          ) : null}
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </motion.div>
      </motion.div>
    </div>
  );
}
