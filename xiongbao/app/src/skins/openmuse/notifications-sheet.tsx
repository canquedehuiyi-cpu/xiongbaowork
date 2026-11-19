import { IconBell, IconHandStop } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { WaitingForYou } from "@/components/approvals/waiting";
import { approvalInboxOptions } from "@/lib/approvals";
import { waitingOnYou } from "./model";
import { LinkRow, MuseEmpty, MuseSheet } from "./ui";

/**
 * The bell: what every Bot is waiting on the person for. The list is OpenBot's own `WaitingForYou`,
 * so every question, approval, choice and detail is exactly the one OpenBot's Bot pages show.
 */
export function NotificationsSheet({ onClose }: { onClose: () => void }) {
  const inbox = useQuery(approvalInboxOptions());
  const nothing =
    inbox.data !== undefined && waitingOnYou(inbox.data).count === 0;
  return (
    <MuseSheet
      onClose={onClose}
      subtitle="员工在等你处理的审批和问题。"
      title="等你处理"
    >
      <div className="flex flex-col gap-3.5">
        {nothing ? (
          <MuseEmpty
            detail="员工需要你同意或回答时，会出现在这里。"
            icon={IconBell}
            title="都处理完了"
          />
        ) : (
          <WaitingForYou />
        )}
        <LinkRow
          detail="员工不用问就能做哪些事"
          icon={IconHandStop}
          render={<Link onClick={onClose} to="/settings/approvals" />}
          tint="lavender"
          title="审批规则"
        />
      </div>
    </MuseSheet>
  );
}
