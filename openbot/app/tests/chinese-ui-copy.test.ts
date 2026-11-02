import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  "components/channels/composer/triggers.ts",
  "components/channels/composer/sources.ts",
  "components/agents/agent-dialog.tsx",
  "components/app-sidebar/app-sidebar.tsx",
  "routes/_authed/_app/group/new.tsx",
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
    });
  }
});
