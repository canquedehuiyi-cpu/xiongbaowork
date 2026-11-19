import {
  IconCircleMinus,
  IconCirclePlus,
  IconHistory,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";
import { DescribeField } from "@/components/boundaries/describe-rule";
import { ReadingStatus } from "@/components/boundaries/rule-reading";
import { PageCard, PageRows } from "@/components/layout/page-shell";
import { SharedApprovalFields } from "@/components/plugins/shared-approval-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { saveAppGrantsMutationOptions } from "@/lib/app-grants/mutations";
import {
  type AppGrantReplay,
  appGrantsReplayQueryOptions,
  type ChangedAction,
  type ReplayedAction,
} from "@/lib/app-grants/queries";
import {
  type AppGrantTranslation,
  translateAppGrants,
} from "@/lib/app-grants/translate";
import { shortName } from "@/lib/brand";
import type { SharedUseApproval } from "@/lib/plugins/shared-use";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

/** What came back for one description, kept beside the words it came from. */
type WrittenGrants = AppGrantTranslation & { text: string };

/** How many rows a list shows before it offers the rest. */
const SHOWN = 6;

/** A count with its measure word, the way the Chinese copy says one: 「3 个动作」「2 次」. */
const plural = (count: number, unit: string) => `${count} ${unit}`;

/** What an action does, in the words the page's own sections use. */
function kindOf(action: Pick<ChangedAction, "effect" | "destructive">) {
  if (action.destructive) return "会删除或破坏";
  return action.effect === "read" ? "只读" : "会改动";
}

/**
 * The change in one sentence, in the order it matters: what goes, then what comes. Exported so the
 * sentence a person reads is assertable without a DOM.
 */
export function changeHeadline(changes: {
  added: readonly unknown[];
  removed: readonly unknown[];
}): string {
  const { added, removed } = changes;
  if (added.length === 0 && removed.length === 0)
    return "这就是员工现在有的，没有要保存的。";
  const parts = [
    removed.length > 0 ? `关掉 ${plural(removed.length, "个动作")}` : null,
    added.length > 0 ? `打开 ${plural(added.length, "个动作")}` : null,
  ].filter(Boolean);
  const sentence = parts.join("，");
  return `保存会${sentence}。`;
}

/**
 * The replay in one sentence: "Turns off 2 actions it used and turns on 9 writes it has never used."
 * Exported for the same reason as {@link changeHeadline}.
 */
export function replayHeadline(report: AppGrantReplay): string {
  const parts = [
    report.removedUsed.length > 0
      ? `关掉它用过的 ${plural(report.removedUsed.length, "个动作")}`
      : null,
    report.refusedGiven.length > 0
      ? `打开它曾被拒绝的 ${plural(report.refusedGiven.length, "个动作")}`
      : null,
    report.addedUnusedWrites.length > 0
      ? `打开它从没用过的 ${plural(report.addedUnusedWrites.length, "个写入动作")}`
      : null,
  ].filter(Boolean) as string[];
  if (parts.length === 0)
    return "不会关掉它用过的动作，也不会打开它没用过的写入动作。";
  return `${parts.join("，")}。`;
}

/** What was replayed, under the headline. */
export function replayWords(report: AppGrantReplay, appTitle: string): string {
  return [
    "按它最近",
    report.runs > 0 ? ` ${plural(report.runs, "次运行")}、` : " ",
    `${plural(report.calls, "次")}调用 ${appTitle} 重放`,
    report.since ? `，最早的一次在${relativeTime(report.since)}。` : "。",
  ].join("");
}

/** One card of actions, a few at a time: a description can turn on thirty of them. */
function ActionRows<T extends ChangedAction>({
  actions,
  icon,
  note,
  verdict,
  verdictClassName,
}: {
  actions: T[];
  icon: React.ReactNode;
  note: (action: T) => string;
  verdict: string;
  verdictClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? actions : actions.slice(0, SHOWN);
  return (
    <>
      <PageRows className="mt-0">
        {shown.map((action, index) => (
          <React.Fragment key={action.ref}>
            <Item size="sm">
              <ItemMedia aria-hidden variant="icon">
                {icon}
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="font-mono text-xs">
                  {action.name}
                </ItemTitle>
                <ItemDescription
                  className={
                    action.destructive ? "text-destructive" : undefined
                  }
                >
                  {note(action)}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <span className={`font-medium text-sm ${verdictClassName}`}>
                  {verdict}
                </span>
              </ItemActions>
            </Item>
            {index !== shown.length - 1 && <Separator />}
          </React.Fragment>
        ))}
      </PageRows>
      {actions.length > SHOWN ? (
        <div>
          <Button
            onClick={() => setOpen(!open)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {open ? "收起" : `显示全部 ${actions.length} 个`}
          </Button>
        </div>
      ) : null}
    </>
  );
}

const TURNS_OFF = "text-amber-600 dark:text-amber-500";
const TURNS_ON = "text-foreground";

/**
 * "Describe what this Bot can do", on one Bot's page for one app.
 *
 * A sentence in, and the deployment's model picks the app's actions that match it. Beside the set:
 * whether every action is one the app offers, a reading of the set by a call that never saw the
 * sentence, what saving would turn on and off, and what that would have meant for the Bot's own
 * recent calls. Nothing changes until Save, which goes through the same checks as the switches below
 * it and records the sentence.
 */
export function DescribeGrants({
  agentId,
  appKey,
  appTitle,
  botName,
  sharedNeeded,
}: {
  agentId: string;
  appKey: string;
  appTitle: string;
  botName: string;
  /**
   * The audience to offer when the app is Shared and this Bot has no approval for it yet, or null
   * when none is needed. Turning an action on then asks who may use the shared account first, as the
   * switches do.
   */
  sharedNeeded: SharedUseApproval | null;
}) {
  const [written, setWritten] = useState<WrittenGrants | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [approval, setApproval] = useState<SharedUseApproval>({
    audience: "team",
    outsideInput: false,
    members: [],
  });
  const save = useMutation(saveAppGrantsMutationOptions(queryClient));
  const checked = written?.check.ok === true;
  const preview = useQuery({
    ...appGrantsReplayQueryOptions(agentId, appKey, written?.grants ?? []),
    enabled: checked,
  });
  const changes = preview.data?.changes;
  const nothingToSave =
    changes !== undefined &&
    changes.added.length === 0 &&
    changes.removed.length === 0;
  const ready =
    checked && preview.data?.check.ok === true && changes && !nothingToSave;

  const commit = (withApproval?: SharedUseApproval) => {
    if (!ready || !written || !changes) return;
    save.mutate(
      {
        agentId,
        app: appKey,
        add: changes.added.map((action) => action.ref),
        remove: changes.removed.map((action) => action.ref),
        authoring: { source: "english", text: written.text },
        ...(withApproval ? { approval: withApproval } : {}),
      },
      {
        onSuccess: () => {
          setAsking(false);
          setWritten(null);
          setSaved(
            `已保存。${botName}现在有你描述的 ${plural(written.grants.length, "个动作")}。`,
          );
        },
      },
    );
  };

  const onSave = () => {
    if (!ready || !changes) return;
    // A Shared app's account is consented to once, before the first action on it, as a switch asks.
    if (sharedNeeded && changes.added.length > 0) {
      setApproval(sharedNeeded);
      setAsking(true);
      return;
    }
    commit();
  };

  return (
    <PageCard
      footer={
        written ? (
          <>
            <Button
              onClick={() => {
                setWritten(null);
                save.reset();
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Discard
            </Button>
            <Button
              disabled={!ready || save.isPending}
              onClick={onSave}
              size="sm"
              type="button"
            >
              {save.isPending ? "正在保存…" : "保存改动"}
            </Button>
          </>
        ) : undefined
      }
    >
      <FieldGroup>
        <DescribeField
          action="选出动作"
          description={`用一句话说 ${botName} 可以在 ${appTitle} 里做什么，你的模型会挑出对应的动作；另一次看不到你原话的解读再说明它们允许什么。`}
          id="app-grants-english"
          label={`描述 ${botName} 能做什么`}
          placeholder="什么都能读，能写草稿，但从不发送、从不删除"
          write={async (described) => {
            const translation = await translateAppGrants({
              agentId,
              app: appKey,
              text: described,
            });
            save.reset();
            setSaved(null);
            setWritten({ ...translation, text: described });
            return null;
          }}
        />
        {saved && !written ? (
          <p className="text-sm" role="status">
            {saved}
          </p>
        ) : null}
        {written ? (
          <ReadingStatus
            check={written.check}
            edited={null}
            explanation={written.explanation}
            failed={`这些动作没通过核对，所以${shortName()}不会保存它们。`}
            heading={`这会让 ${botName} 能做什么`}
            passed={`核对通过：每个动作都是 ${appTitle} 提供的。`}
            warning={written.warning}
          />
        ) : null}
        {checked && preview.error ? (
          <p className="text-destructive text-sm" role="alert">
            {preview.error.message}
          </p>
        ) : null}
        {checked && changes ? (
          <Field aria-labelledby="app-grants-changes" aria-live="polite">
            <FieldLabel id="app-grants-changes">会改变什么</FieldLabel>
            <FieldDescription>{changeHeadline(changes)}</FieldDescription>
            {changes.removed.length > 0 ? (
              <ActionRows
                actions={changes.removed}
                icon={<IconCircleMinus />}
                note={kindOf}
                verdict="关掉"
                verdictClassName={TURNS_OFF}
              />
            ) : null}
            {changes.added.length > 0 ? (
              <ActionRows
                actions={changes.added}
                icon={<IconCirclePlus />}
                note={kindOf}
                verdict="打开"
                verdictClassName={TURNS_ON}
              />
            ) : null}
          </Field>
        ) : null}
        {checked && preview.data && !nothingToSave ? (
          <RecentUse
            appTitle={appTitle}
            botName={botName}
            report={preview.data.report}
          />
        ) : null}
      </FieldGroup>
      {save.error ? (
        <p className="mt-5 text-destructive text-sm" role="alert">
          {save.error.message}
        </p>
      ) : null}
      {/*
       * Stacked over the card, as the switches' own consent dialog is: the shared account is its own
       * moment. Closing it without allowing leaves everything as it was.
       */}
      <Dialog onOpenChange={(next) => !next && setAsking(false)} open={asking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              让 {botName} 使用 {appTitle} 的团队账号？
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4">
            <SharedApprovalFields onChange={setApproval} value={approval} />
          </DialogBody>
          {save.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setAsking(false)}
              size="sm"
              variant="outline"
            >
              取消
            </Button>
            <Button
              disabled={save.isPending}
              onClick={() => commit(approval)}
              size="sm"
            >
              {save.isPending ? "正在保存…" : "允许并保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageCard>
  );
}

/** The change replayed over the Bot's own recent calls to this app. */
function RecentUse({
  report,
  appTitle,
  botName,
}: {
  report: AppGrantReplay | null;
  appTitle: string;
  botName: string;
}) {
  return (
    <Field aria-labelledby="app-grants-replay" aria-live="polite">
      <FieldLabel id="app-grants-replay">按 {botName} 最近的活动</FieldLabel>
      {report === null ? (
        <FieldDescription>
          {shortName()}这里没有可以读的活动记录，所以没有东西可以拿来对照。
        </FieldDescription>
      ) : report.calls === 0 ? (
        <FieldDescription>
          {report.runs > 0
            ? `${botName} 最近 ${plural(report.runs, "次运行")}都没用过 ${appTitle}，所以没有东西可以拿来对照。`
            : `${botName} 还没用过 ${appTitle}，所以没有东西可以拿来对照。`}
          {report.addedUnusedWrites.length > 0
            ? `这会打开它从没用过的 ${plural(report.addedUnusedWrites.length, "个写入动作")}。`
            : ""}
        </FieldDescription>
      ) : (
        <>
          <div>
            <p className="font-medium text-sm">{replayHeadline(report)}</p>
            <FieldDescription className="mt-1">
              {replayWords(report, appTitle)}
            </FieldDescription>
          </div>
          {report.removedUsed.length > 0 ? (
            <ActionRows<ReplayedAction>
              actions={report.removedUsed}
              icon={<IconHistory />}
              note={(action) =>
                `调用过 ${plural(action.calls, "次")}，最近一次在${relativeTime(action.lastCalled)}。`
              }
              verdict="关掉"
              verdictClassName={TURNS_OFF}
            />
          ) : null}
          {report.refusedGiven.length > 0 ? (
            <ActionRows<ReplayedAction>
              actions={report.refusedGiven}
              icon={<IconHistory />}
              note={(action) =>
                `因为没有这个动作被拒绝了 ${plural(action.calls, "次")}，最近一次在${relativeTime(action.lastCalled)}。`
              }
              verdict="打开"
              verdictClassName={TURNS_ON}
            />
          ) : null}
        </>
      )}
      {report && report.calls > 0 && report.addedUnusedWrites.length > 0 ? (
        <FieldDescription>
          {`它从没用过的写入动作：${report.addedUnusedWrites
            .slice(0, 5)
            .map((action) => action.name)
            .join("、")}${
            report.addedUnusedWrites.length > 5
              ? ` 等，另有 ${report.addedUnusedWrites.length - 5} 个`
              : ""
          }。`}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
