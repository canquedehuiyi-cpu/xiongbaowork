import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { browserStepDetails } from "../src/components/channels/browser-activity";
import { PLACEHOLDER_COMMANDS } from "../src/components/channels/composer/sources";
import {
  agentTrigger,
  slashCommandTrigger,
} from "../src/components/channels/composer/triggers";
import { GALLERY as ACTIVITY } from "../src/components/gallery/activity";
import { GALLERY as CARDS } from "../src/components/gallery/cards";
import { GALLERY as CHARTS } from "../src/components/gallery/charts";
import { GALLERY as DECISIONS } from "../src/components/gallery/decisions";
import { GALLERY as FORMS } from "../src/components/gallery/form";
import { GALLERY as QUOTES } from "../src/components/gallery/quote";
import { GALLERY as TABLES } from "../src/components/gallery/table";
import { client } from "../src/lib/client";
import { componentDisplayTitle } from "../src/lib/components/display-title";

/**
 * Story G1: the person-facing copy is Simplified Chinese.
 *
 * Two kinds of guard. The first reads the values the screens actually draw (browser step labels,
 * the composer's empty states and slash commands, the names components are listed under) and
 * requires Chinese in them. The second reads the source of a curated list of person-facing
 * components for English phrases that shipped there before, outside comments, so one coming back
 * fails here rather than in front of somebody.
 */

const HAN = /\p{Script=Han}/u;

describe("values the screens draw are Chinese", () => {
  test("every browser step line reads in Chinese", () => {
    for (const name of [
      "computer_navigate",
      "computer_read",
      "computer_snapshot",
      "computer_click",
      "computer_type",
      "computer_key",
      "computer_scroll",
    ]) {
      const { label } = browserStepDetails({
        kind: "tool",
        id: name,
        toolCall: {
          id: name,
          type: "function",
          function: { name, arguments: "{}" },
        },
        result: '{"ok":true}',
      });
      expect(label, name).toMatch(HAN);
    }
    expect(
      browserStepDetails({
        kind: "tool",
        id: "type",
        toolCall: {
          id: "type",
          type: "function",
          function: { name: "computer_type", arguments: "{}" },
        },
      }).label,
    ).toBe("填写了字段");
  });

  test("the composer's empty states and placeholder command are Chinese", () => {
    const mention = agentTrigger([]) as { emptyMessage?: string };
    const command = slashCommandTrigger([]) as { emptyMessage?: string };
    expect(mention.emptyMessage).toBe("这个频道里还没有员工");
    expect(command.emptyMessage).toBe("没有匹配的命令");
    expect(PLACEHOLDER_COMMANDS.length).toBeGreaterThan(0);
    for (const entry of PLACEHOLDER_COMMANDS) {
      expect(entry.description ?? "", entry.id).toMatch(HAN);
      if (entry.kind === "prompt") expect(entry.prompt, entry.id).toMatch(HAN);
    }
  });

  test("every built-in component is listed under a Chinese name", () => {
    const all = [
      ...ACTIVITY,
      ...CARDS,
      ...CHARTS,
      ...DECISIONS,
      ...FORMS,
      ...QUOTES,
      ...TABLES,
    ];
    expect(all.length).toBeGreaterThan(10);
    for (const component of all) {
      // The registry title stays English on purpose: the server's headless registry holds the same
      // title for the same name. What a person reads is the display title.
      expect(componentDisplayTitle(component), component.name).toMatch(HAN);
    }
    expect(
      componentDisplayTitle({
        name: "showActivityReport",
        title: "Activity report",
      }),
    ).toBe("活动报告");
  });
});

const SRC = join(import.meta.dir, "..", "src");

/** Person-facing surfaces whose copy G1 translated. Paths are relative to `app/src`. */
const CURATED = [
  "components/channels/browser-activity.tsx",
  "components/channels/chat-transcript.tsx",
  "components/channels/composer/triggers.tsx",
  "components/channels/composer/sources.ts",
  "components/agents/agent-dialog.tsx",
  "components/app-sidebar/app-sidebar.tsx",
  "routes/_authed/_app/group/new.tsx",
  "components/skills/skill-tools.tsx",
  "lib/dictation/session.ts",
  "lib/voice/archive.ts",
  "lib/bot-lifecycle/mutations.ts",
  "lib/agents/queries.ts",
  "lib/dictation/recording.ts",
  "lib/auth/client.ts",
  "lib/auth/queries.ts",
  "lib/channels/mutations.ts",
  "lib/channels/queries.ts",
  "lib/models/mutations.ts",
  "lib/models/queries.ts",
] as const;

/** English copy that previously reached people from the files above. */
const FORMER_ENGLISH = [
  "Filled in field",
  '"issue"',
  '"issues"',
  "No agents in this channel",
  "No matching commands",
  "Summarize this conversation",
  "Summarize what we covered",
  "That value does not fit",
  "Could not save",
  "Saved. It applies",
  "Saved for reuse",
  '"Cleared."',
  "出现在这里 here",
  '"first", "second", "third"',
  "answers {",
  " via {origin.via}",
  "changes something",
  "Microphone access was denied",
  "Could not start recording",
  "Could not finish recording",
  "Transcription failed",
  "Could not load voice chats",
  "Could not save this voice chat",
  "browser recovery is unavailable",
  "The page closed before saving",
  "Bot operation failed",
  "Could not reset this Bot",
  "Could not stop the delegated task",
  "Could not cancel the follow-up",
  "Could not save where updates go",
  "Could not load what this deployment supports",
  "Could not load coworkers",
  "Could not load this coworker",
  "Could not load which Bots",
  "could not be tested",
  "Dictation requires a supported browser",
  "cannot record a supported audio format",
  "Recording is too large",
  "The microphone stopped recording",
  "Recording was interrupted",
  "Recording stopped before audio",
  "The recording is empty or unsupported",
  "No speech was detected",
  "sign-in.`",
  "No identity provider is registered",
  "did not sign you in",
  "Could not create the account",
  "Could not load sign-in",
  "Could not load the current user",
  "Could not start a channel",
  "Could not pin this channel",
  "Could not mark this channel read",
  "Could not delete this channel",
  "Could not load channels",
  "Could not load this channel",
  "could not be done with this model",
  "model could not be connected",
  "connectivity test could not be run",
  "using this model could not be loaded",
  "model library could not be loaded",
] as const;

/** Comments may say anything; only code is copy. Block comments, JSX comments and `//` lines go. */
function code(path: string): string {
  return readFileSync(join(SRC, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("curated person-facing files carry no English copy", () => {
  for (const path of CURATED) {
    test(path, () => {
      const source = code(path);
      for (const phrase of FORMER_ENGLISH) {
        expect(source.includes(phrase), `${path}: ${phrase}`).toBeFalse();
      }
      // A label, title or placeholder of two or more English words, with no Chinese, is copy that
      // was not translated. Brand names and code samples are single tokens and pass.
      for (const match of source.matchAll(
        /\b(?:aria-label|title|placeholder)=\{?"([^"]*)"/g,
      )) {
        const value = match[1] ?? "";
        const english = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(value);
        expect(english && !HAN.test(value), `${path}: ${value}`).toBeFalse();
      }
      // JSX text that reads as an English sentence: a capitalised word followed by more words,
      // standing alone between tags.
      for (const match of source.matchAll(/>\s*([^<>{}]+?)\s*</g)) {
        const text = match[1] ?? "";
        const english = /^[A-Z][a-z]+(?:\s+[a-z]+){2,}/.test(text);
        expect(english && !HAN.test(text), `${path}: ${text}`).toBeFalse();
      }
      // Error copy a screen shows when a request or the microphone fails: the `fallback`, `error`,
      // `saveError` and `reason` a person reads, a shared `FALLBACK`-style constant, the message of
      // an `Error` thrown to a screen, and the default after `??` or `||`. Template literals count
      // too: a provider name or a status code spliced into English is still English.
      for (const match of source.matchAll(
        /(?:\b(?:fallback|error|saveError|reason):|\bconst\s+[A-Z_]+\s*=|new Error\(|\?\?|\|\||(?:^|\s)[?:])\s*(?:"([^"]*)"|`([^`]*)`)/gm,
      )) {
        const value = match[1] ?? match[2] ?? "";
        // Two or more plain English words ("Load failed.") read as copy. Class lists
        // (`line-clamp-2`) are hyphenated tokens and do not count.
        const english =
          value
            .split(/\s+/)
            .filter((token) => /^[A-Za-z]{2,}[,.;:!?']?$/.test(token)).length >=
          2;
        expect(english && !HAN.test(value), `${path}: ${value}`).toBeFalse();
      }
    });
  }
});

/** Every `.ts`/`.tsx` under `SRC`, tests excluded: a test asserting an English string is not copy. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test."))
      out.push(path);
  }
  return out;
}

/**
 * The sentence a screen shows when a request fails — everywhere, not just in the curated list.
 *
 * WHY THIS IS BROADER THAN THE BLOCK ABOVE. That one reads nineteen files whose copy G1 translated, and
 * after the fact: a phrase that shipped there once may not come back. But the sentence a person reads
 * when the server breaks is not concentrated in nineteen files — it is written at every call site
 * (`fallback:`), plus the shared `FALLBACK`-style constants those call sites name. Measured on
 * 2026-11-16, `app/src` held **68 of them in English**, and the DOM scan could not see any of it: its
 * empty answers are all 200, so the failure screen had never been rendered once. A person's most likely
 * screenshot ("it just says Could not load reachability") came from a layer nothing was measuring.
 *
 * So the rule is stated once, over the whole tree: a failure sentence must contain Chinese. The scan
 * measures the same layer from the outside (an all-500 state in `i18n-dom-scan.test.tsx`); this one
 * stops a new English fallback from being written in the first place, including on screens the scan
 * does not walk.
 */
describe("every failure sentence says something in Chinese", () => {
  /** Inline `fallback:` at a call site, and the shared constants those call sites name. */
  const CALL_SITE = /fallback:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
  const NAMED_CONST =
    /const\s+(?:[A-Z0-9]+_)*FALLBACK(?:_[A-Z0-9]+)*\s*(?::\s*string\s*)?=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;

  test("no fallback under app/src is written in English", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const rel = relative(SRC, path);
      const source = code(rel);
      for (const pattern of [CALL_SITE, NAMED_CONST]) {
        for (const match of source.matchAll(pattern)) {
          const value = match.slice(1).find((one) => one !== undefined) ?? "";
          if (!HAN.test(value)) offenders.push(`${rel}: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * The two defaults inside the transport itself. They are not `fallback:` literals at a call site, so
   * the sweep above cannot see them — and they are what a person reads when a screen forgets to name
   * one, which is exactly the case nobody reviews.
   */
  test("a refusal with no sentence of its own still reads in Chinese", async () => {
    const original = globalThis.fetch;
    const answer = (init: ResponseInit, body = "") =>
      (async () => new Response(body, init)) as unknown as typeof fetch;
    try {
      // 500 and no JSON body: the server said nothing, so the transport's own default reaches the screen.
      globalThis.fetch = answer({ status: 500 });
      const refused = await client("/api/anything").catch((error) => error);
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toMatch(HAN);

      // 200 whose body is not an object: a malformed success is a failed request too.
      globalThis.fetch = answer({ status: 200 }, "null");
      const malformed = await client("/api/anything", "items").catch(
        (error) => error,
      );
      expect(malformed).toBeInstanceOf(Error);
      expect((malformed as Error).message).toMatch(HAN);
    } finally {
      globalThis.fetch = original;
    }
  });
});
