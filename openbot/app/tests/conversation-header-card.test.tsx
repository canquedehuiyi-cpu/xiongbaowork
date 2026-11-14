import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  CONVERSATION_HEADER_CLASS,
  ConversationHeaderCard,
} from "@/components/channels/conversation-header-card";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/* The compact employee card pinned in the conversation header: it must never scroll away. */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const agent = {
  id: "expense-review",
  name: "Expense Review",
  title: "Finance Operations",
  avatarSeed: "seed-1",
  visibility: "private" as const,
};

function draw(screen: ReactNode, edition: "team" | "personal" = "team") {
  const client = new QueryClient();
  client.setQueryData(deploymentKeys.capabilities(), { edition });
  return render(
    <QueryClientProvider client={client}>{screen}</QueryClientProvider>,
  );
}

test("renders name, title and the 仅自己 tag", () => {
  const view = draw(<ConversationHeaderCard agent={agent as never} />);
  view.getByText("Expense Review");
  const title = view.getByText("Finance Operations");
  expect(title.className).toContain("truncate");
  view.getByText("仅自己");
});

test("a public employee says 公开", () => {
  const view = draw(
    <ConversationHeaderCard
      agent={{ ...agent, visibility: "public" } as never}
    />,
  );
  view.getByText("公开");
});

test("personal edition renders no visibility tag", () => {
  const view = draw(
    <ConversationHeaderCard agent={agent as never} />,
    "personal",
  );
  expect(view.queryByText("仅自己")).toBeNull();
  expect(view.queryByText("公开")).toBeNull();
  view.getByText("Expense Review");
});

test("the header is sticky at the top and holds the card", () => {
  const view = draw(
    <div className={CONVERSATION_HEADER_CLASS} data-slot="conversation-header">
      <ConversationHeaderCard agent={agent as never} />
    </div>,
  );
  const header = view.container.querySelector(
    '[data-slot="conversation-header"]',
  ) as HTMLElement;
  expect(header.className).toContain("sticky");
  expect(header.className).toContain("top-0");
  expect(header.textContent).toContain("Expense Review");
});
