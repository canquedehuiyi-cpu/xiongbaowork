import { outcomeForPerson } from "@openbot/shared/approval-outcomes";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { ComputerView } from "@/components/computer/computer-view";
import { HelpRequestCard } from "@/components/computer/help-request-card";
import {
  commandStatus,
  TerminalBlock,
} from "@/components/computer/terminal-block";
import { client, tryClient } from "@/lib/client";
import { noteBrowsed, outputOf, readOutcome } from "@/lib/computers/activity";
import { callComputer, type ToolOutcome } from "@/lib/computers/call";
import { type ControlState, readControl } from "@/lib/computers/control";
import {
  runBrowserRead,
  runHelpRequest,
  runNavigation,
} from "@/lib/computers/handoff";
import {
  type ComputerMachine,
  computerToolPlace,
  DEVICE_RUN_COMMAND_DESCRIPTION,
} from "../../../../shared/computer-tool-words";
import {
  DESKTOP_REF,
  DESKTOP_WINDOW_ID,
} from "../../../../shared/desktop-control";
import {
  CANDIDATE_REF,
  LOCAL_TOOL_DESCRIPTIONS,
} from "../../../../shared/local-tools";
import {
  type ToolCallContext,
  useActiveBotHolder,
  useBotOfCall,
  useDeclaredBotId,
} from "./active-bot";
import { useFrontendTool } from "./approval-tools";
import { type OfferRule, useOfferedTo } from "./bot-offer";
import {
  offeredBrowser,
  offeredComputer,
  offeredDrivable,
  offeredNavigate,
} from "./computer-available";

/**
 * Frontend registrations for computer tools, including inline rendering and policy-refusal display.
 */

export type { ToolOutcome } from "@/lib/computers/call";
/** What every computer call returns to the model: either the result, or a reason it did not happen. */
export { callComputer } from "@/lib/computers/call";

/**
 * Secret-entry wait window. Browser takeovers use server-authoritative request state instead.
 */
const WAIT_FOR_SECRET_MS = 10 * 60_000;

/** How often the waiting handler asks whether the person has answered yet. */
const WAIT_POLL_MS = 1_000;

/** Hold the secret-entry call open until its masked prompt is answered, cancelled, or expires. */
async function waitForSecret(
  botId: string,
  done: (state: ControlState) => boolean,
  signal: AbortSignal | undefined,
  giveUpAfterMs = WAIT_FOR_SECRET_MS,
): Promise<"answered" | "gave up" | "cancelled"> {
  const deadline = Date.now() + giveUpAfterMs;
  while (Date.now() < deadline) {
    // Stop must actually stop, including out of a wait. The SDK aborts this when a person presses it.
    if (signal?.aborted) return "cancelled";
    const state = await readControl(botId).catch(() => null);
    if (state && done(state)) return "answered";
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  return "gave up";
}

/** What a computer tool's render can read back out of its own result. */
type ComputerOutcome = {
  ok?: boolean;
  stopped?: boolean;
  humanHasControl?: boolean;
  entries?: unknown[];
  refused?: boolean;
  /** Handed to the person, who did it themselves. Done, and not by the Bot. */
  doneByPerson?: boolean;
  /** The person said no to it. */
  declined?: boolean;
  reason?: string;
  staleRefs?: boolean;
  /** The computer was still starting and the call was not performed. */
  starting?: boolean;
  elements?: unknown[];
  element?: { role?: string; name?: string };
  /** What a shell call reports back, so the line can show the output rather than only the command. */
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** The far side cut the output short, or stopped the command. */
  truncated?: boolean;
  timedOut?: boolean;
  /** A file write. The size, never what was written. */
  bytes?: number;
  /** A file read. Named `text` on the way back and `contents` on the way in. */
  text?: string;
  /** Where a navigation landed, which is what a finished turn's screen tile remembers. */
  url?: string;
  title?: string;
};

/**
 * Read the SDK-render result string so the transcript can distinguish success, refusal, failure and
 * a step the person did themselves.
 *
 * The Activity pane's reader, so the line and the pane beside it say the same thing. This one read a
 * sentence (the server's answer for a step that was declined or not carried out) as an empty success,
 * and the line said "Ran a command ... It printed nothing." beside a pane that said "You declined it."
 */
function outcomeOf(result: string | undefined): ComputerOutcome {
  return (readOutcome(result) ?? {}) as ComputerOutcome;
}

/**
 * The label of the element an action touched, as the gateway resolved it server-side.
 *
 * Not taken from the model's arguments: those carry only a ref. The server looked the element up in
 * the snapshot it took itself, which is the same value it wrote to the audit trail, so the transcript
 * and the audit row name the thing identically.
 */
function labelOf(result: string | undefined): string | undefined {
  const element = (outcomeOf(result) as { element?: { name?: unknown } })
    .element;
  const name = element?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * A compact transcript line that distinguishes policy refusals from ordinary failures.
 */
function ActionLine({
  label,
  attempted,
  detail,
  running,
  refused,
  failed,
  notYet,
  byYou,
  declined,
}: {
  label: string;
  /** 被拦截时的未完成说法，见 `ToolLine` 的同名属性。 */
  attempted?: string;
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
  /** The computer was still starting, so nothing was done yet. See `stillStarting`. */
  notYet?: boolean;
  /** It was handed to the person, who did it themselves. See `ToolLine`. */
  byYou?: boolean;
  /** 拒绝它的是主人自己，不是策略或边界：行上写「已拒绝」而不是「已拦截」。 */
  declined?: boolean;
}) {
  return (
    <ToolLine
      attempted={attempted}
      byYou={byYou}
      declined={declined}
      detail={notYet ? STILL_STARTING_DETAIL : detail}
      failed={failed}
      label={label}
      notYet={notYet}
      refused={refused}
      running={running}
    />
  );
}

/** What a line says about a call that waited on a computer still starting. */
const STILL_STARTING_DETAIL = "电脑还在启动。";

/**
 * What a refused step's line says after its words: what it was aimed at, then why it did not
 * happen, as one phrase ("notes.txt · You declined it."). The target alone hid the reason; the reason
 * alone hid which file or field it was.
 */
function refusedDetail(target: string | undefined, outcome: ComputerOutcome) {
  const reason = outcomeForPerson(String(outcome.reason ?? ""));
  return [target, reason].filter(Boolean).join(" · ");
}

/** Whether a result is an ordinary failure rather than a refusal, so the two can render differently. */
function didNotWork(outcome: ComputerOutcome): boolean {
  return (
    outcome.ok === false &&
    outcome.refused !== true &&
    outcome.starting !== true
  );
}

/**
 * Whether a call came back because the computer was still starting, and so did nothing.
 *
 * Not a failure, and not drawn as one. A cold start can outlast the server's wait, and when it does
 * the call is turned away before anything reaches the computer. Drawn as "didn't work" in amber, it
 * read as a broken computer during the one minute every first start takes.
 */
function stillStarting(outcome: ComputerOutcome): boolean {
  return outcome.ok === false && outcome.starting === true;
}

/** Whether the step was handed to the person and they did it themselves, so the Bot did not. */
function byPerson(outcome: ComputerOutcome): boolean {
  return outcome.doneByPerson === true;
}

/**
 * Who is offered each computer tool: a Bot this person may drive, as far as this deployment's
 * switches allow. Not offered to a Team Bot's teammates, nor where a switch would refuse it; see
 * `computerToolsOffered`. Asked of the Bot whose run it is, never the one on screen (`bot-offer.ts`).
 */
const OFFERED: Readonly<Record<string, OfferRule>> = {
  computer_navigate: offeredNavigate,
  computer_read: offeredBrowser,
  computer_snapshot: offeredBrowser,
  computer_type: offeredBrowser,
  computer_click: offeredBrowser,
  computer_key: offeredBrowser,
  computer_request_secret: offeredBrowser,
  // Audit bookkeeping rather than a computer action, so it answers only the first question.
  report_refusal: offeredDrivable,
  computer_request_help: offeredBrowser,
  computer_list_files: offeredComputer,
  computer_read_file: offeredComputer,
  computer_run_command: offeredComputer,
  computer_write_file: offeredComputer,
  computer_scroll: offeredBrowser,
};

export function ComputerTools() {
  /*
   * WHOSE COMPUTER, ASKED TWO WAYS. A handler acts for the Bot that made the call, which a turn the
   * person walked away from keeps making while another screen, or another Bot, is in front of them;
   * acting on the screen's Bot there opened pages and ran commands on the wrong computer. A renderer
   * draws a call in the conversation on screen, whose Bot is the screen's, so it reads the holder.
   */
  const botOf = useBotOfCall();
  const bot = useActiveBotHolder();
  const { allowed: localTools, machine } = useLocalTools();
  const onDevice = machine === "device";
  const place = computerToolPlace(machine);
  useOfferedTo(OFFERED);

  useFrontendTool({
    name: "computer_navigate",
    description:
      "Open a web page on your own computer so the person can watch. Use this when asked to open, " +
      "visit or read a particular website. It is not a web search: never open a search engine with " +
      "it to look something up. Returns the page title and its readable text, so answer from what " +
      "comes back rather than telling the person to go and look.",
    parameters: z.object({
      url: z.string().describe("Full web address to open, including https://"),
    }),
    handler: async (
      { url }: { url: string },
      // Context is optional in the SDK.
      { signal, toolCall, agent }: ToolCallContext = {},
    ) => {
      const computerId = botOf(agent);
      const result = await runNavigation(computerId, url, toolCall?.id, signal);
      if (result.ok) noteBrowsed(computerId);
      return result;
    },
    render: ({ result, status, toolCallId }) => {
      /*
       * The page this turn left open, so reopening the conversation shows what it browsed rather
       * than what the Bot has open now. Only once the turn is finished: while it runs, the live
       * frames are its own.
       */
      /*
       * A RESULT IS WHAT MAKES A TURN OVER, not the status.
       *
       * A restored tool call arrives with its result already in hand and a status that is briefly
       * something other than complete, so keying on the status alone made every reopened turn look
       * like one still running: the tile polled the live screen, put today's page under yesterday's
       * answer, and only then restored the frame it should have shown from the start.
       */
      const finished = status === "complete" || result !== undefined;
      const outcome = finished ? outcomeOf(result) : {};
      const page =
        typeof outcome.url === "string"
          ? {
              url: outcome.url,
              ...(typeof outcome.title === "string"
                ? { title: outcome.title }
                : {}),
            }
          : undefined;
      return (
        <div className="my-2">
          <ComputerView
            computerId={bot.current}
            active={!finished}
            /*
             * FINISHED, NOT "GOT SOMEWHERE". The tile used to count a turn as history only once it
             * had a page, so a navigation that was refused, failed or stopped never settled: it kept
             * polling the live screen under a turn that was over, and offered control of it. Those
             * are the turns most worth freezing, because the thing on screen has nothing to do with
             * what the person is reading.
             */
            finished={finished}
            {...(page ? { page } : {})}
            {...(toolCallId ? { toolCallId } : {})}
          />
        </div>
      );
    },
  });

  useFrontendTool({
    name: "computer_read",
    description:
      "Read the page currently open on your computer, without opening anything. Use this after you " +
      "click something that changes the page, such as submitting a form, to find out what it now says.",
    parameters: z.object({}),
    handler: async (
      _input: Record<string, never>,
      { signal, toolCall, agent }: ToolCallContext = {},
    ) => runBrowserRead(botOf(agent), "/read", toolCall?.id, signal),
    render: () => null,
  });

  useFrontendTool({
    name: "computer_snapshot",
    description:
      "List the things on the current page you can act on: fields, buttons, links and checkboxes, " +
      "each with a ref, its label and its current value. Call this BEFORE clicking or typing, and " +
      "use the refs it returns. Always send back the snapshotId it gives you. If an action reports " +
      "that your refs are stale, the page changed: call this again and use the new refs.",
    parameters: z.object({}),
    handler: async (
      _input: Record<string, never>,
      { signal, toolCall, agent }: ToolCallContext = {},
    ) => runBrowserRead(botOf(agent), "/snapshot", toolCall?.id, signal),
    // Snapshot renders a count only; navigate owns the screen view.
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const elements = Array.isArray(outcome.elements) ? outcome.elements : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label="读取了页面"
          attempted="读取页面"
          detail={
            elements.length
              ? `${elements.length} thing${elements.length === 1 ? "" : "s"} it can act on`
              : undefined
          }
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_type",
    description:
      "Enter text into a field on the page. Give the ref of the field from your most recent " +
      "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
      "Set submit to true to press Enter afterwards.",
    parameters: z.object({
      ref: z
        .string()
        .describe("Ref of the field, from your most recent snapshot"),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
      text: z.string().describe("The text to enter"),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter after typing, to submit a single-field form"),
    }),
    handler: async (
      input: {
        ref: string;
        snapshotId: number;
        text: string;
        submit?: boolean;
      },
      { signal, agent }: ToolCallContext = {},
    ) =>
      callComputer(
        botOf(agent),
        "/type",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ args, result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="填写了"
        attempted="填写"
        detail={(() => {
          // Never show typed values; identify only the target field.
          const field =
            labelOf(result) ??
            (typeof args?.ref === "string" ? args.ref : undefined);
          return outcomeOf(result).refused === true
            ? refusedDetail(field, outcomeOf(result))
            : field;
        })()}
        declined={outcomeOf(result).declined === true}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
        notYet={stillStarting(outcomeOf(result))}
        byYou={byPerson(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    name: "computer_click",
    description:
      "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
      "from your most recent snapshot and the snapshotId it came from.",
    parameters: z.object({
      ref: z
        .string()
        .describe(
          "Ref of the element to click, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    handler: async (
      input: { ref: string; snapshotId: number },
      { signal, agent }: ToolCallContext = {},
    ) =>
      callComputer(
        botOf(agent),
        "/click",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label="点击了"
          attempted="点击"
          detail={
            // A refusal names the element only by the label the server resolved, never its ref.
            outcome.refused === true
              ? refusedDetail(labelOf(result), outcome)
              : (labelOf(result) ??
                (typeof args?.ref === "string" ? args.ref : undefined))
          }
          declined={outcome.declined === true}
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
          notYet={stillStarting(outcome)}
          byYou={byPerson(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_key",
    description:
      "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
      "is focused, or omit the ref to press it on the page.",
    parameters: z.object({
      key: z.string().describe("Key name, such as Enter, Tab or Escape"),
      ref: z.string().optional().describe("Optional ref to press the key on"),
      snapshotId: z
        .number()
        .optional()
        .describe("The snapshotId the ref came from, required if ref is given"),
    }),
    handler: async (
      input: {
        key: string;
        ref?: string;
        snapshotId?: number;
      },
      { signal, agent }: ToolCallContext = {},
    ) =>
      callComputer(
        botOf(agent),
        "/key",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ args, result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="按下了"
        attempted="按键"
        detail={
          outcomeOf(result).refused === true
            ? refusedDetail(
                typeof args?.key === "string" ? args.key : undefined,
                outcomeOf(result),
              )
            : typeof args?.key === "string"
              ? args.key
              : undefined
        }
        declined={outcomeOf(result).declined === true}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
        notYet={stillStarting(outcomeOf(result))}
        byYou={byPerson(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    name: "computer_request_secret",
    description:
      "Ask the person for ONE value you must not be told: a password, a one-time code, a card number. " +
      "Focus the field first with computer_click, then call this with the ref of that field and a " +
      "short label for what you need. They type it into a masked box that goes straight to the page. " +
      "You will never see the value, and you must not ask for it any other way. Prefer this over a " +
      "full takeover when you only need one field filled in. The value is only TYPED into the field: " +
      "if the form needs submitting, do that yourself afterwards with computer_click.",
    parameters: z.object({
      label: z
        .string()
        .describe(
          "What you need, in a few words, e.g. 'the code sent to your phone'",
        ),
      ref: z
        .string()
        .describe(
          "Ref of the field it goes in, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    handler: async (
      input: { label: string; ref: string; snapshotId: number },
      { signal, agent }: ToolCallContext = {},
    ) => {
      const botId = botOf(agent);
      const asked = await callComputer(
        botId,
        "/control/secret",
        {
          method: "POST",
          body: input,
        },
        signal,
      );
      if (!asked.ok) return asked;

      // Completion is `secretWanted` clearing; the value never returns to the model.
      const outcome = await waitForSecret(
        botId,
        (state) => state.secretWanted === undefined,
        signal,
      );
      return {
        ok: true,
        result:
          outcome === "answered"
            ? `The person has entered ${input.label} into the field. It was typed straight into the page and you were not told what it is.`
            : outcome === "cancelled"
              ? "The request was cancelled."
              : `Nobody entered ${input.label}. Do not ask for it another way.`,
      };
    },
    // Rendered by ComputerView as a masked prompt.
    render: () => null,
  });

  /** Self-reported model declines: audit evidence, not an enforcement control. */
  useFrontendTool({
    name: "report_refusal",
    description:
      "Record that you DECLINED something you were asked to do, because it looked unsafe, was outside " +
      "what you are for, or you judged you should not. Call this whenever you say no to a request, in " +
      "addition to telling the person. It changes nothing about your answer; it exists so an " +
      "administrator can see what this Bot is being asked to do. Do not call it when you simply could " +
      "not do something, only when you chose not to.",
    parameters: z.object({
      reason: z
        .string()
        .describe("Why you declined, in one sentence and in your own words"),
      request: z
        .string()
        .optional()
        .describe("What you were asked to do, in a few words"),
    }),
    handler: async (
      input: { reason: string; request?: string },
      { signal, agent }: ToolCallContext = {},
    ) => {
      try {
        const response = await tryClient(
          `/api/agents/${encodeURIComponent(botOf(agent))}/declined`,
          { method: "POST", body: input, signal },
        );
        return response.ok
          ? "Recorded. Now tell the person what you decided and why."
          : "That could not be recorded. Tell the person what you decided anyway.";
      } catch {
        // Audit bookkeeping must not prevent the Bot from answering.
        return "That could not be recorded. Tell the person what you decided anyway.";
      }
    },
    render: () => null,
  });

  useFrontendTool({
    name: "computer_request_help",
    description:
      "Ask the person to take control of your computer and do something you cannot: sign in, enter a " +
      "password or a one-time code, or clear a CAPTCHA. Say specifically what you need done. They " +
      "will drive the browser themselves and hand it back, and you carry on in the same session. " +
      "Use this INSTEAD of giving up, and instead of ever asking them to type a password to you. " +
      "This call is the only thing that reaches them: until you make it they are not looking at the " +
      "page and have no way to help, so saying you need them to sign in, or asking whether they would " +
      "like to proceed, hands over nothing and leaves the page where it is.",
    parameters: z.object({
      reason: z
        .string()
        .describe(
          "What you need the person to do, in one sentence, e.g. 'This page is asking for a code sent to your phone.'",
        ),
    }),
    handler: async (
      input: { reason: string },
      { signal, toolCall, agent }: ToolCallContext = {},
    ) => runHelpRequest(botOf(agent), input.reason, toolCall?.id, signal),
    // The Bot's screen with the wheel while the request is open, then a line saying what was asked and what came of it.
    render: ({ args, result, toolCallId }) => (
      <HelpRequestCard
        botId={bot.current}
        reason={typeof args?.reason === "string" ? args.reason : undefined}
        result={result}
        toolCallId={toolCallId}
      />
    ),
  });

  useFrontendTool({
    name: "computer_list_files",
    description: onDevice
      ? `List files and folders in ${place}. Call first before reading an uncertain filename. Never guess a filename.`
      : "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
        "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
        "are not sure of. Never guess a filename.",
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe("Optional folder to list. Omit for the whole workspace."),
    }),
    // Activity is read from the conversation this answer lands in: see `useConversationActivity`.
    handler: async (
      input: { path?: string },
      { agent }: ToolCallContext = {},
    ) =>
      callComputer(botOf(agent), "/files/list", {
        method: "POST",
        body: input ?? {},
      }),
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const entries = Array.isArray(outcome.entries) ? outcome.entries : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label="列出了文件"
          attempted="列出文件"
          detail={
            outcome.refused === true || didNotWork(outcome)
              ? outcomeForPerson(String(outcome.reason ?? ""))
              : byPerson(outcome)
                ? undefined
                : entries.length
                  ? `${entries.length} item${entries.length === 1 ? "" : "s"} in the workspace`
                  : "nothing saved yet"
          }
          declined={outcome.declined === true}
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
          notYet={stillStarting(outcome)}
          byYou={byPerson(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_read_file",
    description: onDevice
      ? `Read a saved file relative to ${place}, such as notes.md or reports/august.csv. The folder survives between conversations, so use this to pick up notes you made before.`
      : "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
        "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
        "this to pick up notes you made before.",
    parameters: z.object({
      path: z
        .string()
        .describe("Path relative to your workspace, such as notes.md"),
    }),
    handler: async (input: { path: string }, { agent }: ToolCallContext = {}) =>
      callComputer(botOf(agent), "/files/read", {
        method: "POST",
        body: input,
      }),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label="读取了文件"
          attempted="读取文件"
          detail={
            outcome.refused === true
              ? refusedDetail(
                  typeof args?.path === "string" ? args.path : undefined,
                  outcome,
                )
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          declined={outcome.declined === true}
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
          notYet={stillStarting(outcome)}
          byYou={byPerson(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_run_command",
    description: onDevice
      ? DEVICE_RUN_COMMAND_DESCRIPTION
      : "Run a shell command on your own computer. Use this for anything the browser cannot do: " +
        "installing a tool you need, processing a file you saved, running a script. The working " +
        "directory is your workspace, so paths are relative to it and files you write here are the " +
        "same ones the file tools see. Commands run in bash, so pipes and && work. Long output is " +
        "truncated from the start, and a command that runs too long is stopped. " +
        "Use the tools already installed first. If you need a new one, prefer installing it inside " +
        "your workspace: `npm install <package>` (without -g), `bun add <package>`, or " +
        "`python3 -m venv .venv` and then `.venv/bin/pip install <package>`. If you are told you " +
        "have no sudo permission, do not try to escalate; say so rather than retrying.",
    parameters: z.object({
      command: z
        .string()
        .describe(
          onDevice
            ? "The command to run, written for the paired machine's own system"
            : "The command to run, such as: npm install marked",
        ),
    }),
    /*
     * NOT WHERE ACTIVITY IS RECORDED, though it once was. A command is a change, and the approval
     * wrapper sends a change to the server's gate without calling this at all: the gate runs it and
     * answers, or runs it after a person allows it and continues the conversation itself. Recorded
     * here, the pane beside the screen stayed empty while a Bot ran command after command. Every one
     * of those paths ends with the answer in the conversation, which is what the pane reads; see
     * `useConversationActivity`.
     */
    handler: async (
      input: { command: string },
      { signal, agent }: ToolCallContext = {},
    ) =>
      callComputer(
        botOf(agent),
        "/exec",
        { method: "POST", body: input },
        signal,
      ),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      /*
       * A terminal block: the prompt and the command, the end of what it printed (the rest folds
       * away), and how it exited, clicking through to the live terminal in the Computer panel. This
       * ran on a machine holding somebody's logins, so what it printed is always reachable here
       * rather than taken on the model's word.
       */
      const byYou = byPerson(outcome);
      const refused = outcome.refused === true;
      return (
        <TerminalBlock
          command={typeof args?.command === "string" ? args.command : ""}
          computerId={bot.current}
          output={
            refused
              ? outcomeForPerson(String(outcome.reason ?? ""))
              : stillStarting(outcome)
                ? STILL_STARTING_DETAIL
                : outputOf(outcome as ToolOutcome)
          }
          status={commandStatus({
            running: status !== "complete",
            starting: stillStarting(outcome),
            refused,
            declined: outcome.declined === true,
            byYou,
            ...(typeof outcome.exitCode === "number"
              ? { exitCode: outcome.exitCode }
              : {}),
            timedOut: outcome.timedOut === true,
            failed: didNotWork(outcome),
          })}
          truncated={outcome.truncated === true}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_write_file",
    description: onDevice
      ? `Save text in ${place}. Paths are relative to it and folders are created as needed. Set append to true to add to the end of an existing file rather than replacing it.`
      : "Save a file in your own workspace so you still have it later. Paths are relative to your " +
        "workspace and folders are created as needed. Set append to true to add to the end of an " +
        "existing file rather than replacing it. Text only.",
    parameters: z.object({
      path: z
        .string()
        .describe(
          "Path relative to your workspace, such as reports/august.csv",
        ),
      contents: z.string().describe("The text to save"),
      append: z
        .boolean()
        .optional()
        .describe("Add to the end of the file instead of replacing it"),
    }),
    handler: async (
      input: {
        path: string;
        contents: string;
        append?: boolean;
      },
      { agent }: ToolCallContext = {},
    ) =>
      callComputer(botOf(agent), "/files/write", {
        method: "POST",
        body: input,
      }),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          // The words the approval card and Activity use for the same action.
          label={args?.append === true ? "追加到文件" : "保存了文件"}
          attempted={args?.append === true ? "追加到文件" : "保存文件"}
          // Show the path, never file contents.
          detail={
            outcome.refused === true
              ? refusedDetail(
                  typeof args?.path === "string" ? args.path : undefined,
                  outcome,
                )
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          declined={outcome.declined === true}
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
          notYet={stillStarting(outcome)}
          byYou={byPerson(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_scroll",
    description:
      "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
    parameters: z.object({
      deltaY: z
        .number()
        .optional()
        .describe("Pixels to scroll; positive is down. Defaults to 600."),
    }),
    handler: async (
      input: { deltaY?: number },
      { signal, agent }: ToolCallContext = {},
    ) =>
      callComputer(
        botOf(agent),
        "/scroll",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="滚动了"
        attempted="滚动"
        declined={outcomeOf(result).declined === true}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
        notYet={stillStarting(outcomeOf(result))}
        byYou={byPerson(outcomeOf(result))}
      />
    ),
  });

  return localTools ? <LocalTools /> : null;
}

/**
 * Whether this person is offered the Bot owner's local apps and desktop, as the server answers it:
 * device mode, and the Bot's owner asking, which is the rule the unattended run's tools follow. Also
 * where the shell and file tools act (`machine`), which is the server's and true for every viewer.
 *
 * No until the server says yes, unlike the computer tools above: these act on the owner's own
 * machine, so nobody else is shown them even for a moment. The gateway refuses everyone else anyway.
 */
function useLocalTools(): { allowed: boolean; machine: ComputerMachine } {
  const declared = useDeclaredBotId();
  const { data } = useQuery({
    queryKey: ["computers", "local-tools", declared ?? ""],
    queryFn: async () => {
      const response = await client(
        `/api/computers/${encodeURIComponent(declared ?? "")}/local-tools`,
        { fallback: "读不到本机应用是否可用。" },
      );
      return (await response.json()) as {
        allowed?: boolean;
        machine?: ComputerMachine;
      };
    },
    enabled: declared !== undefined,
    staleTime: 60_000,
  });
  return {
    allowed: data?.allowed === true,
    // The cloud words stand until the server says this is a paired machine: they are the old ones.
    machine: data?.machine === "device" ? "device" : "workspace",
  };
}

/** What the local-app and desktop results carry that their transcript lines read back. */
type LocalOutcome = ComputerOutcome & {
  apps?: { name?: unknown }[];
  windows?: unknown[];
  enabled?: { name?: unknown };
  window?: { title?: unknown };
};

/** A refusal's or failure's reason, else what `detail` makes of a result that worked. */
function localDetail(
  outcome: LocalOutcome,
  detail: () => string | undefined,
): string | undefined {
  return outcome.refused === true || didNotWork(outcome)
    ? String(outcome.reason ?? "")
    : detail();
}

/**
 * The owner's local apps and desktop (真机验收 2026-11-09: the unattended run had these and the web
 * chat did not). Mounted only when `useLocalToolsAllowed` says yes, so for anyone else they are not
 * registered at all.
 *
 * Names, words and parameters are the server's (`shared/local-tools.ts`). A listing goes straight to
 * its route; a call, an enable and a window read may need the owner's approval, so `useFrontendTool`
 * sends those through the approval route, as it does a command. The desktop is read only: nothing
 * here clicks, types, presses a key or launches anything.
 */
// M4: 待接入 本机应用与桌面工具仍按屏幕上的员工（`bot.current`）调用，也未声明 `useOfferedTo` 规则；上游的电脑工具已改为按调用所属员工（`useBotOfCall`）执行、按员工决定是否提供。
function LocalTools() {
  const bot = useActiveBotHolder();

  useFrontendTool({
    name: "computer_apps",
    description: LOCAL_TOOL_DESCRIPTIONS.computer_apps,
    parameters: z.strictObject({ app: z.string().min(1).max(40).optional() }),
    handler: async (
      input: { app?: string },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/apps/list",
        { method: "POST", body: input ?? {} },
        signal,
      ),
    render: ({ result, status }) => {
      const outcome = outcomeOf(result) as LocalOutcome;
      return (
        <ActionLine
          running={status !== "complete"}
          label="查看了本机应用"
          attempted="查看本机应用"
          detail={localDetail(outcome, () => {
            const names = (outcome.apps ?? [])
              .map((app) => app?.name)
              .filter((name): name is string => typeof name === "string");
            return names.length ? names.join("、") : "还没有本机应用";
          })}
          declined={outcome.declined === true}
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_app_call",
    description: LOCAL_TOOL_DESCRIPTIONS.computer_app_call,
    parameters: z.strictObject({
      app: z.string().min(1).max(40),
      // No `*`: the tool is half of the approval scope, where `*` would match every tool.
      tool: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[^*]+$/),
      args: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async (
      input: { app: string; tool: string; args?: Record<string, unknown> },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/apps/call",
        { method: "POST", body: input },
        signal,
      ),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result) as LocalOutcome;
      return (
        <ActionLine
          running={status !== "complete"}
          label="调用了本机应用"
          attempted="调用本机应用"
          detail={localDetail(outcome, () =>
            typeof args?.app === "string" && typeof args?.tool === "string"
              ? `${args.app} · ${args.tool}`
              : undefined,
          )}
          declined={outcome.declined === true}
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_app_enable",
    description: LOCAL_TOOL_DESCRIPTIONS.computer_app_enable,
    parameters: z.strictObject({ candidate: z.string().regex(CANDIDATE_REF) }),
    handler: async (
      input: { candidate: string },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/apps/enable",
        { method: "POST", body: input },
        signal,
      ),
    render: ({ result, status }) => {
      const outcome = outcomeOf(result) as LocalOutcome;
      return (
        <ActionLine
          running={status !== "complete"}
          label="启用了本机应用"
          attempted="启用本机应用"
          detail={localDetail(outcome, () =>
            typeof outcome.enabled?.name === "string"
              ? outcome.enabled.name
              : undefined,
          )}
          declined={outcome.declined === true}
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_desktop_windows",
    description: LOCAL_TOOL_DESCRIPTIONS.computer_desktop_windows,
    parameters: z.strictObject({}),
    handler: async (
      _input: Record<string, never>,
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/desktop/windows",
        { method: "POST", body: {} },
        signal,
      ),
    render: ({ result, status }) => {
      const outcome = outcomeOf(result) as LocalOutcome;
      return (
        <ActionLine
          running={status !== "complete"}
          label="查看了桌面窗口"
          attempted="查看桌面窗口"
          detail={localDetail(outcome, () =>
            Array.isArray(outcome.windows)
              ? `${outcome.windows.length} 个窗口`
              : undefined,
          )}
          declined={outcome.declined === true}
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_desktop_snapshot",
    description: LOCAL_TOOL_DESCRIPTIONS.computer_desktop_snapshot,
    parameters: z.strictObject({
      windowId: z.string().regex(DESKTOP_WINDOW_ID),
      from: z.string().regex(DESKTOP_REF).optional(),
      screenshot: z.boolean().optional(),
    }),
    handler: async (
      input: { windowId: string; from?: string; screenshot?: boolean },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/desktop/snapshot",
        { method: "POST", body: input },
        signal,
      ),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result) as LocalOutcome;
      return (
        <ActionLine
          running={status !== "complete"}
          label="读取了桌面窗口"
          attempted="读取桌面窗口"
          detail={localDetail(outcome, () =>
            typeof outcome.window?.title === "string"
              ? outcome.window.title
              : typeof args?.windowId === "string"
                ? args.windowId
                : undefined,
          )}
          declined={outcome.declined === true}
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  return null;
}
