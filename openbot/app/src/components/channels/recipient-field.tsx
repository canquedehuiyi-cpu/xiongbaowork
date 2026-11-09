import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  addRecipient,
  MAX_RECIPIENTS,
  type Recipient,
  removeRecipient,
} from "@/components/channels/compose-state";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * Who a conversation that does not exist yet is with.
 *
 * Uses the same recipient list model as compose state, even while channels are capped at one
 * coworker.
 */
export function RecipientField({
  recipients,
  onChange,
}: {
  recipients: readonly Recipient[];
  onChange: (next: Recipient[]) => void;
}) {
  const { data: profiles } = useQuery(agentListQueryOptions());
  const [search, setSearch] = useState("");

  const chosen = new Set(recipients.map((recipient) => recipient.id));
  const matches = (profiles ?? [])
    .filter((profile) => !chosen.has(profile.id))
    .filter((profile) =>
      profile.name.toLowerCase().includes(search.trim().toLowerCase()),
    );
  const isFull = recipients.length >= MAX_RECIPIENTS;

  return (
    <div className="border-b border-border px-4 py-2">
      <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-1.5">
        <span className="text-sm text-muted-foreground">发给：</span>

        {recipients.map((recipient) => (
          <Button
            key={recipient.id}
            onClick={() => onChange(removeRecipient(recipients, recipient.id))}
            size="xs"
            variant="secondary"
          >
            <ChannelAvatar participantIds={[recipient.id]} size={16} />
            {recipient.name}
            <span aria-hidden>×</span>
            <span className="sr-only">移除 {recipient.name}</span>
          </Button>
        ))}

        {isFull ? null : (
          <InputGroup className="h-8 w-56 border-none bg-transparent">
            <InputGroupInput
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
              aria-label="选择一位员工"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="选择一位员工…"
=======
              aria-label="Choose a Bot"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Choose a Bot…"
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
              value={search}
            />
            <InputGroupAddon />
          </InputGroup>
        )}
      </div>

      {isFull || search.trim().length === 0 ? null : (
        <ul className="mx-auto mt-1 w-full max-w-2xl">
          {matches.map((profile) => (
            <li key={profile.id}>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onChange(
                    addRecipient(recipients, {
                      id: profile.id,
                      name: profile.name,
                    }),
                  );
                  setSearch("");
                }}
                type="button"
              >
                <ChannelAvatar participantIds={[profile.id]} size={18} />
                <span>{profile.name}</span>
                <span className="text-muted-foreground">{profile.title}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
              没有叫这个名字的员工。
=======
              No Bot by that name.
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
