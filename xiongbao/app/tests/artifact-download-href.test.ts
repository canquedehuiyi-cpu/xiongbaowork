import type { Message } from "@ag-ui/core";
import { describe, expect, test } from "bun:test";
import {
  artifactDownloadHref,
  artifactFolderOf,
  artifactPathOf,
  writtenPathsInTurn,
} from "@/lib/computers/artifact";

/**
 * The normalization matrix behind every artifact link.
 *
 * Each row is a promise the transcript either makes or refuses. The refusals are the load-bearing
 * half: a link that arrives at a 404 is worse than no link, because the chat has just told the person
 * the file is there. The workspace keeps its own confinement (`assertInside` in
 * `agent-computer/src/workspace.ts`) and refuses these too — this is the chat not offering an address
 * it already knows ends in a refusal.
 */

const BOT = "bot-7";
const HREF = (path: string) =>
  `/api/computers/${BOT}/files/download?path=${encodeURIComponent(path)}`;

describe("a path the download route can be asked for", () => {
  test.each([
    ["notes.md", "notes.md"],
    ["reports/quarterly.md", "reports/quarterly.md"],
    ["a/deeply/nested/path/report.pdf", "a/deeply/nested/path/report.pdf"],
    ["one two/three four.txt", "one two/three four.txt"],
    ["报告/季度 报表.pdf", "报告/季度 报表.pdf"],
    ["./notes.md", "notes.md"],
    ["reports//august.md", "reports/august.md"],
    ["reports/august.md/", "reports/august.md"],
    ["  reports/august.md  ", "reports/august.md"],
    ["reports\\august.md", "reports/august.md"],
  ])("%s is asked for as %s", (path, asked) => {
    expect(artifactDownloadHref(BOT, path)).toBe(HREF(asked));
  });

  test("a slash is left alone and everything else that could extend the query is encoded", () => {
    // `encodeURIComponent` keeps `/`, so the workspace's own folders stay readable in the address,
    // while a `?`, `&` or `#` inside a file name cannot open a second query on the way back.
    expect(artifactDownloadHref(BOT, "a?b=1&c=2.txt")).toBe(
      "/api/computers/bot-7/files/download?path=a%3Fb%3D1%26c%3D2.txt",
    );
    expect(artifactDownloadHref(BOT, "reports/季度#2.pdf")).toBe(
      "/api/computers/bot-7/files/download?path=reports/%E5%AD%A3%E5%BA%A6%232.pdf",
    );
  });

  test("the Bot id is encoded too, because it is the other half of the address", () => {
    expect(artifactDownloadHref("bot 7", "a.txt")).toBe(
      "/api/computers/bot%207/files/download?path=a.txt",
    );
  });
});

describe("a path that gets no link", () => {
  test.each([
    ["not a string", 7],
    ["null", null],
    ["undefined", undefined],
    ["an object", { path: "a.txt" }],
    ["empty", ""],
    ["only spaces", "   "],
    ["a bare dot", "./"],
    ["absolute", "/etc/passwd"],
    ["home-relative", "~/secrets.env"],
    ["a drive letter", "C:\\work\\a.txt"],
    ["a drive letter written forward", "c:/work/a.txt"],
    ["climbing out", "../etc/passwd"],
    ["climbing out from inside", "reports/../../etc/passwd"],
    ["climbing out with backslashes", "reports\\..\\..\\etc\\passwd"],
    ["a bare parent segment", "notes/.."],
  ])("%s", (_name, path) => {
    expect(artifactDownloadHref(BOT, path)).toBeUndefined();
  });

  test.each([
    ["no bot", undefined],
    ["an empty bot", ""],
    ["a blank bot", "   "],
  ] as const)("%s", (_name, botId) => {
    expect(artifactDownloadHref(botId, "a.txt")).toBeUndefined();
  });

  test("a bot id that is not a string gets no link", () => {
    expect(
      artifactDownloadHref(7 as unknown as string | undefined, "a.txt"),
    ).toBeUndefined();
  });

  test("a segment merely starting with two dots is not an escape", () => {
    // `..notes.md` and `..hidden` are ordinary names a workspace can hold; refusing them would take
    // the link away from the files the person asked for.
    expect(artifactDownloadHref(BOT, "..notes.md")).toBe(HREF("..notes.md"));
    expect(artifactDownloadHref(BOT, "reports/..hidden/a.txt")).toBe(
      HREF("reports/..hidden/a.txt"),
    );
  });
});

describe("which folder a written path is listed from", () => {
  test.each([
    ["notes.md", "."],
    ["./notes.md", "."],
    ["reports/quarterly.md", "reports"],
    ["a/b/c/report.pdf", "a/b/c"],
    ["reports\\quarterly.md", "reports"],
    // A path the route would never be asked for lists the workspace, where the row cannot match:
    // it is refused for a link elsewhere, so this only keeps the folder never empty.
    ["/leading.md", "."],
  ])("%s is listed from %s", (path, folder) => {
    expect(artifactFolderOf(path)).toBe(folder);
  });
});

describe("which path a saved file is named by", () => {
  test("the answer's path stands, and the request is the fallback", () => {
    expect(artifactPathOf("reports/a.md", "./other.md")).toBe("reports/a.md");
    expect(artifactPathOf(undefined, "./reports/a.md")).toBe("reports/a.md");
    expect(artifactPathOf(null, 7)).toBeUndefined();
    // The answer is preferred, but an answer that names nothing the route can reach falls back to
    // the request rather than losing the file.
    expect(artifactPathOf("/tmp/a.md", "reports/a.md")).toBe("reports/a.md");
  });
});

/** One saved file, as the run left it in the conversation. */
function written(
  id: string,
  asked: string,
  answer: Record<string, unknown> | string | undefined,
): Message[] {
  return [
    {
      id: `${id}-call`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name: "computer_write_file", arguments: asked },
        },
      ],
    },
    ...(answer === undefined
      ? []
      : [
          {
            id: `${id}-result`,
            role: "tool",
            toolCallId: id,
            content: typeof answer === "string" ? answer : JSON.stringify(answer),
          },
        ]),
  ] as unknown as Message[];
}

const SAVED = (path: string) => ({ ok: true, path, bytes: 12 });

describe("the files of this turn", () => {
  test("one saved file is listed", () => {
    const messages = [
      { id: "u1", role: "user", content: "写个报告" } as unknown as Message,
      ...written("c1", '{"path":"deliverables/report.md"}', SAVED("deliverables/report.md")),
    ];
    expect(writtenPathsInTurn(messages)).toEqual(["deliverables/report.md"]);
  });

  test("the turn is what followed the last message the person sent", () => {
    const messages = [
      { id: "u1", role: "user", content: "先写一份" } as unknown as Message,
      ...written("c1", '{"path":"a.md"}', SAVED("a.md")),
      { id: "u2", role: "user", content: "再来一份" } as unknown as Message,
      ...written("c2", '{"path":"b.md"}', SAVED("b.md")),
    ];
    expect(writtenPathsInTurn(messages)).toEqual(["b.md"]);
  });

  test("appending to the same file is one artifact, named once, in the order it was first written", () => {
    const messages = [
      { id: "u1", role: "user", content: "继续" } as unknown as Message,
      ...written("c1", '{"path":"log.md"}', SAVED("log.md")),
      ...written("c2", '{"path":"log.md","append":true}', SAVED("./log.md")),
      ...written("c3", '{"path":"notes.md"}', SAVED("notes.md")),
      ...written("c4", '{"path":"log.md","append":true}', SAVED("log.md")),
    ];
    expect(writtenPathsInTurn(messages)).toEqual(["log.md", "notes.md"]);
  });

  test("a file is named by the answer when it has no path of its own", () => {
    const messages = [
      { id: "u1", role: "user", content: "继续" } as unknown as Message,
      ...written("c1", '{"path":"./out/a.md"}', { ok: true, bytes: 3 }),
    ];
    expect(writtenPathsInTurn(messages)).toEqual(["out/a.md"]);
  });

  test.each([
    ["refused by a policy", { ok: false, refused: true, reason: "越界" }],
    ["it did not work", { ok: false, reason: "The folder could not be written." }],
    ["the person did it themselves", { ok: true, doneByPerson: true }],
    ["still held for an answer", "Waiting for you"],
    ["an answer that is not an object", "saved"],
  ])("a write %s is not an artifact", (_name, answer) => {
    const messages = [
      { id: "u1", role: "user", content: "继续" } as unknown as Message,
      ...written("c1", '{"path":"a.md"}', answer),
    ];
    expect(writtenPathsInTurn(messages)).toEqual([]);
  });

  test("a write that never answered is not an artifact", () => {
    const messages = [
      { id: "u1", role: "user", content: "继续" } as unknown as Message,
      ...written("c1", '{"path":"a.md"}', undefined),
    ];
    expect(writtenPathsInTurn(messages)).toEqual([]);
  });

  test("another tool is not a saved file", () => {
    const messages = [
      { id: "u1", role: "user", content: "继续" } as unknown as Message,
      {
        id: "m1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c9",
            type: "function",
            function: {
              name: "computer_read_file",
              arguments: '{"path":"a.md"}',
            },
          },
          {
            id: "c10",
            type: "function",
            // Arguments that are not JSON at all: a malformed call names no file, and nothing throws.
            function: { name: "computer_write_file", arguments: "{path" },
          },
        ],
      },
      {
        id: "r9",
        role: "tool",
        toolCallId: "c9",
        content: JSON.stringify({ ok: true, path: "a.md" }),
      },
      {
        id: "r10",
        role: "tool",
        toolCallId: "c10",
        content: JSON.stringify({ ok: true, path: "b.md" }),
      },
    ] as unknown as Message[];
    expect(writtenPathsInTurn(messages)).toEqual(["b.md"]);
  });

  test("a path the route would refuse never reaches the list", () => {
    const messages = [
      { id: "u1", role: "user", content: "继续" } as unknown as Message,
      ...written("c1", '{"path":"/etc/passwd"}', SAVED("/etc/passwd")),
      ...written("c2", '{"path":"../a.md"}', SAVED("../a.md")),
    ];
    expect(writtenPathsInTurn(messages)).toEqual([]);
  });

  test("a history with no message of the person's is read from its first item", () => {
    expect(writtenPathsInTurn([])).toEqual([]);
    expect(
      writtenPathsInTurn([
        ...written("c1", '{"path":"a.md"}', SAVED("a.md")),
      ]),
    ).toEqual(["a.md"]);
  });
});
