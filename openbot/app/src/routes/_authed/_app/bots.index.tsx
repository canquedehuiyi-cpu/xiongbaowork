<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { createFileRoute, redirect } from "@tanstack/react-router";
=======
import { IconBook, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { BotRoster } from "@/components/bots/bot-roster";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/** Just longer than the sheet's 200ms exit, so it has finished sliding away before the page changes. */
const SHEET_CLOSE_MS = 240;
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

/**
 * Bot 会话, archived into 员工管理 (`/wakers`): this page listed the same employees as the wall, each
 * with what it needs from the person. That summary is now on each card there (from the same
 * `GET /api/bots/attention` read the sidebar already makes), and each card links to the employee's
 * own `/bots/$agentId` profile, which stays where it was.
 *
 * The file stays so `/bots` keeps resolving for bookmarks and old links. It carried no parameters,
 * so the wall opens unfiltered. `replace`, so Back does not bounce through the redirect.
 */
export const Route = createFileRoute("/_authed/_app/bots/")({
  beforeLoad: () => {
    throw redirect({ replace: true, search: {}, to: "/wakers" });
  },
});
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
=======

function BotsPage() {
  const { new: creating } = Route.useSearch();
  const navigate = Route.useNavigate();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return (
    <PageShell
      action={
        <Button
          render={(props) => (
            <Link {...props} search={{ new: true }} to="/bots" />
          )}
          size="sm"
          variant="ghost"
        >
          <IconPlus />
          New Bot
        </Button>
      }
      description={
        personal
          ? "Your Bots for everyday work."
          : "Manage your Bots and access those shared with you."
      }
      title="Bots"
    >
      <BotRoster />
      {personal ? <WhatYourBotsKnow /> : null}
      <NewBotSheet
        onClose={() => void navigate({ search: {} })}
        onCreated={(agentId) => {
          /*
           * Close first, then go. Navigating straight to the Bot unmounted this page with the sheet
           * still on it, so it vanished instead of sliding away. Replacing the `?new` entry means Back
           * from the new Bot lands on the roster, not on an empty sheet.
           */
          void navigate({ replace: true, search: {} });
          window.setTimeout(
            () =>
              void navigate({
                params: { agentId },
                search: {},
                to: "/bots/$agentId",
              }),
            SHEET_CLOSE_MS,
          );
        }}
        open={creating === true}
      />
    </PageShell>
  );
}

/**
 * Capabilities, in the personal edition, where it is not a page of its own: what a person's Bots
 * know how to do, beneath the Bots themselves. No Memory row: the personal edition has no memory
 * (see `offersMemory`).
 */
function WhatYourBotsKnow() {
  return (
    <PageSection title="What your Bots know">
      <PageRows>
        <Item render={<Link to="/capabilities/skills" />} size="sm">
          <ItemMedia variant="icon">
            <IconBook />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Skills</ItemTitle>
            <ItemDescription>
              Step-by-step instructions you wrote or your Bots learned.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
