import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { QuotaGuidanceDialog } from "../components/quota/quota-guidance-dialog";
import { currentUserQueryOptions, needsOnboarding } from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { rememberShareImport, takeShareImport } from "../lib/wakerflows";
=======
import type { ReactNode } from "react";
import { BotLookProvider } from "../components/agents/bot-look";
import { TeamFeaturesDialog } from "../components/edition/team-features-dialog";
import { currentUserQueryOptions, needsOnboarding } from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { SkinAccountSync } from "../skins/account-sync";
import { useActiveSkin } from "../skins/registry";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      // WF9 (D9): a WakerFlow share link opened signed out is come back to after signing in.
      rememberShareImport(location.pathname);
      throw redirect({ to: "/sign" });
    }
    /*
     * Somebody who has not finished onboarding goes there and nowhere else. Here rather than in
     * `_app`, so admin and settings are behind the same gate; checked against the destination so
     * the onboarding route itself stays reachable.
     */
    if (needsOnboarding(user) && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding" });
    }
    if (!needsOnboarding(user)) {
      const token = takeShareImport();
      if (token && !location.pathname.endsWith(token))
        throw redirect({
          to: "/wakerflows/import/$token",
          params: { token },
        });
    }
  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: () => (
    <CopilotProvider>
      <AppHotkeys />
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
      <Outlet />
      {/*
       * Every structured quota refusal lands here, once (K4). Here rather than in `_app`, so a refusal
       * met on settings, admin or onboarding gets the same way out as one met in the app shell.
       */}
      <QuotaGuidanceDialog />
=======
      {/* The skin saved on the account, drawn over the browser's cached one once it loads. */}
      <SkinAccountSync />
      {/* Opened by the personal edition's "OpenBot for Business" entry, from whichever skin draws it. */}
      <TeamFeaturesDialog />
      <SkinBotLook>
        <Outlet />
      </SkinBotLook>
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    </CopilotProvider>
  ),
});

/** Bots are drawn the way the active skin asks for, on every authed page. */
function SkinBotLook({ children }: { children: ReactNode }) {
  return (
    <BotLookProvider value={useActiveSkin().botLook ?? "face"}>
      {children}
    </BotLookProvider>
  );
}
