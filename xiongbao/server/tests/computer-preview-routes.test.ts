import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import type { MiddlewareHandler } from "hono";
import {
  computerDownloadHeaders,
  FILE_BYTES_HEADER,
} from "../../shared/file-download";
import { TEXT_PREVIEW_BYTES } from "../../shared/preview-kind";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { ArtifactAccessDeps } from "../src/computer/artifact-access";
import { createComputerTransport } from "../src/computer/client";
import { personSeat } from "../src/computer/computer-key";
import type { ComputerGateway } from "../src/computer/gateway";
import {
  ActionRefusedError,
  ComputerUnavailableError,
  WorkspaceNotFoundError,
} from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

const member: AuthenticatedActor = {
  id: "user-1",
  email: "member@xiongbao.test",
  role: "user",
};

function asActor(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", member);
    await next();
  };
}

function streamOf(bytes: Uint8Array, chunk = 64 * 1024) {
  let offset = 0;
  const state = { cancelled: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      const next = bytes.subarray(offset, offset + chunk);
      offset += next.byteLength;
      state.pulled += next.byteLength;
      controller.enqueue(next);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

type Calls = {
  downloads: Array<{ botId: string; path: string; signal?: unknown }>;
  pdfs: Array<{ botId: string; path: string }>;
};

function gatewayWith(options: {
  files?: Record<string, Uint8Array>;
  /** What the computer claims a file's length is, when that is not the length it then sends. */
  declared?: Record<string, number>;
  pdf?: { bytes: Uint8Array } | { unavailable: true } | Error;
  streams?: Array<{ cancelled: boolean; pulled: number }>;
}) {
  const calls: Calls = { downloads: [], pdfs: [] };
  const gateway = {
    seatFor: async (botId: string, personId: string) =>
      personSeat(personId, botId),
    downloadFile: async (
      seat: { botId: string },
      _actor: { id: string },
      input: { path: string },
      signal?: unknown,
    ) => {
      calls.downloads.push({ botId: seat.botId, path: input.path, signal });
      const bytes = options.files?.[input.path];
      if (!bytes) throw new WorkspaceNotFoundError("No such file.");
      const { stream, state } = streamOf(bytes);
      options.streams?.push(state);
      return {
        body: stream,
        bytes: options.declared?.[input.path] ?? bytes.byteLength,
        name: input.path.split("/").pop() ?? "download",
      };
    },
    previewPdf: async (
      seat: { botId: string },
      _actor: { id: string },
      input: { path: string },
    ) => {
      calls.pdfs.push({ botId: seat.botId, path: input.path });
      const result = options.pdf;
      if (result instanceof Error) throw result;
      if (!result || "unavailable" in result) return { unavailable: true };
      return {
        body: streamOf(result.bytes).stream,
        bytes: result.bytes.byteLength,
      };
    },
  } as unknown as ComputerGateway;
  return { gateway, calls };
}

function appFor(
  gateway: ComputerGateway,
  canUseBot: (
    actor: AgentActor,
    botId: string,
  ) => Promise<boolean> = async () => true,
  artifactAccess?: ArtifactAccessDeps,
) {
  return createComputerRoutes(
    gateway,
    {} as PolicyStore,
    asActor(),
    canUseBot,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    artifactAccess,
  );
}

const base = "http://xiongbao.test/bot-17/files";
const encode = (path: string) => encodeURIComponent(path);
const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("the inline preview route", () => {
  test("serves html under the sandbox, with the type set by the route", async () => {
    const { gateway, calls } = gatewayWith({
      files: { "site/index.html": bytesOf("<script>alert(1)</script>") },
    });
    const response = await appFor(gateway).request(
      `${base}/preview?path=${encode("site/index.html")}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp.startsWith("sandbox allow-scripts")).toBe(true);
    expect(csp).not.toContain("allow-same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(await response.text()).toBe("<script>alert(1)</script>");
    expect(calls.downloads.map((call) => call.path)).toEqual([
      "site/index.html",
    ]);
  });

  test.each([
    ["a.png", "image/png"],
    ["a.JPG", "image/jpeg"],
    ["a.mp4", "video/mp4"],
    ["a.mp3", "audio/mpeg"],
  ])("serves %s as %s, sandboxed", async (name, type) => {
    const { gateway } = gatewayWith({ files: { [name]: bytesOf("xyz") } });
    const response = await appFor(gateway).request(
      `${base}/preview?path=${encode(name)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-security-policy")).toMatch(
      /^sandbox allow-scripts;/,
    );
  });

  test("serves a pdf as application/pdf, inline", async () => {
    const { gateway } = gatewayWith({
      files: { "a.pdf": bytesOf("%PDF-1.4") },
    });
    const response = await appFor(gateway).request(
      `${base}/preview?path=a.pdf`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(await response.text()).toBe("%PDF-1.4");
  });

  test("ignores what the file holds: html bytes under a .png name stay an image", async () => {
    const { gateway } = gatewayWith({
      files: { "a.png": bytesOf("<html><script>alert(1)</script>") },
    });
    const response = await appFor(gateway).request(
      `${base}/preview?path=a.png`,
    );
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  test.each([
    ["an svg", "logo.svg"],
    ["markdown", "a.md"],
    ["a csv", "a.csv"],
    ["a text file", "a.txt"],
    ["an unknown type", "a.bin"],
    ["no extension", "Makefile"],
  ])("answers 415 for %s without asking the gateway", async (_name, path) => {
    const { gateway, calls } = gatewayWith({ files: { [path]: bytesOf("x") } });
    const response = await appFor(gateway).request(
      `${base}/preview?path=${encode(path)}`,
    );

    expect(response.status).toBe(415);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(calls.downloads).toHaveLength(0);
    expect(calls.pdfs).toHaveLength(0);
  });

  test("a missing path is a 400 before the gateway", async () => {
    const { gateway, calls } = gatewayWith({});
    const response = await appFor(gateway).request(`${base}/preview`);
    expect(response.status).toBe(400);
    expect(calls.downloads).toHaveLength(0);
  });

  test("an Office file is served as the converted pdf, inline and named .pdf", async () => {
    const pdf = bytesOf("%PDF-1.7 converted");
    const { gateway, calls } = gatewayWith({ pdf: { bytes: pdf } });
    const response = await appFor(gateway).request(
      `${base}/preview?path=${encode("deck/季度 汇报.PPTX")}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe(String(pdf.byteLength));
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(response.headers.get("content-disposition")).toContain(".pdf");
    expect(response.headers.get("content-security-policy")).toMatch(
      /^sandbox allow-scripts;/,
    );
    expect(await response.text()).toBe("%PDF-1.7 converted");
    expect(calls.pdfs).toEqual([
      { botId: "bot-17", path: "deck/季度 汇报.PPTX" },
    ]);
    expect(calls.downloads).toHaveLength(0);
  });

  test("an Office file with no converter answers 200 unavailable", async () => {
    const { gateway } = gatewayWith({ pdf: { unavailable: true } });
    const response = await appFor(gateway).request(
      `${base}/preview?path=a.docx`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toBeNull();
    await expect(response.json()).resolves.toEqual({ unavailable: true });
  });

  test("a failed conversion is the gateway's error, not a file", async () => {
    const { gateway } = gatewayWith({
      pdf: new ActionRefusedError("No.", "r"),
    });
    const response = await appFor(gateway).request(
      `${base}/preview?path=a.docx`,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("content-disposition")).toBeNull();
  });

  test("the request's cancel reaches the computer", async () => {
    const { gateway, calls } = gatewayWith({
      files: { "a.png": bytesOf("x") },
    });
    const controller = new AbortController();
    await appFor(gateway).request(`${base}/preview?path=a.png`, {
      signal: controller.signal,
    });
    expect(calls.downloads[0]?.signal).toBe(controller.signal);
  });

  test.each([
    "报告 #1?%.html",
    "a b.html",
    "100%.html",
    "q#r.html",
    "who?.html",
  ])("the disposition carries %p intact", async (name) => {
    const { gateway } = gatewayWith({ files: { [name]: bytesOf("x") } });
    const response = await appFor(gateway).request(
      `${base}/preview?path=${encode(name)}`,
    );
    const header = response.headers.get("content-disposition") ?? "";
    const encoded = /filename\*=UTF-8''([^;]*)$/.exec(header)?.[1] ?? "";

    expect(response.status).toBe(200);
    expect(header).toMatch(/^inline; filename="/);
    expect(header).not.toMatch(/[\r\n]/);
    expect(decodeURIComponent(encoded)).toBe(name);
  });
});

describe("the text preview route", () => {
  test("returns a small file whole", async () => {
    const { gateway } = gatewayWith({ files: { "a.md": bytesOf("# 你好\n") } });
    const response = await appFor(gateway).request(`${base}/text?path=a.md`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({
      kind: "markdown",
      text: "# 你好\n",
      truncated: false,
      bytes: bytesOf("# 你好\n").byteLength,
    });
  });

  test.each([
    ["a.csv", "csv"],
    ["a.TXT", "text"],
    ["a.ts", "text"],
  ])("names %s as %s", async (name, kind) => {
    const { gateway } = gatewayWith({ files: { [name]: bytesOf("a,b") } });
    const response = await appFor(gateway).request(
      `${base}/text?path=${encode(name)}`,
    );
    const body = (await response.json()) as { kind: string };
    expect(body.kind).toBe(kind);
  });

  test("stops at one mebibyte, says so, and cancels the upstream stream", async () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(97);
    const streams: Array<{ cancelled: boolean; pulled: number }> = [];
    const { gateway } = gatewayWith({ files: { "big.txt": big }, streams });
    const response = await appFor(gateway).request(`${base}/text?path=big.txt`);
    const body = (await response.json()) as {
      text: string;
      truncated: boolean;
      bytes: number;
    };

    expect(response.status).toBe(200);
    expect(body.truncated).toBe(true);
    expect(body.text.length).toBe(TEXT_PREVIEW_BYTES);
    expect(body.bytes).toBe(big.byteLength);
    expect(streams[0]?.cancelled).toBe(true);
    expect(streams[0]?.pulled).toBeLessThan(big.byteLength);
  });

  test("a file of exactly one mebibyte is not truncated", async () => {
    const exact = new Uint8Array(TEXT_PREVIEW_BYTES).fill(98);
    const { gateway } = gatewayWith({ files: { "exact.txt": exact } });
    const response = await appFor(gateway).request(
      `${base}/text?path=exact.txt`,
    );
    const body = (await response.json()) as {
      text: string;
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.text.length).toBe(TEXT_PREVIEW_BYTES);
  });

  test("a cut inside a multi-byte character leaves no half character", async () => {
    const bytes = new Uint8Array(TEXT_PREVIEW_BYTES + 10).fill(97);
    // 3-byte characters straddling the limit: the last one starts one byte before it.
    bytes.set(bytesOf("你"), TEXT_PREVIEW_BYTES - 1);
    const { gateway } = gatewayWith({ files: { "cut.txt": bytes } });
    const response = await appFor(gateway).request(`${base}/text?path=cut.txt`);
    const body = (await response.json()) as {
      text: string;
      truncated: boolean;
    };
    expect(body.truncated).toBe(true);
    expect(body.text).not.toContain("�");
    expect(body.text.length).toBe(TEXT_PREVIEW_BYTES - 1);
  });

  test("invalid utf-8 is replaced, never thrown", async () => {
    const { gateway } = gatewayWith({
      files: { "a.txt": Uint8Array.from([0x61, 0xff, 0x62]) },
    });
    const response = await appFor(gateway).request(`${base}/text?path=a.txt`);
    const body = (await response.json()) as { text: string };
    expect(response.status).toBe(200);
    expect(body.text).toBe("a�b");
  });

  test("html comes back as a string inside JSON, never as a page", async () => {
    const { gateway } = gatewayWith({
      files: { "a.txt": bytesOf("<script>alert(1)</script>") },
    });
    const response = await appFor(gateway).request(`${base}/text?path=a.txt`);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-type")).not.toContain("html");
    const body = (await response.json()) as { text: string };
    expect(body.text).toBe("<script>alert(1)</script>");
  });

  test.each([
    ["an image", "a.png"],
    ["a pdf", "a.pdf"],
    ["html", "a.html"],
    ["an svg", "a.svg"],
    ["an Office file", "a.pptx"],
    ["an unknown type", "a.bin"],
  ])("answers 415 for %s without asking the gateway", async (_name, path) => {
    const { gateway, calls } = gatewayWith({ files: { [path]: bytesOf("x") } });
    const response = await appFor(gateway).request(
      `${base}/text?path=${encode(path)}`,
    );
    expect(response.status).toBe(415);
    expect(calls.downloads).toHaveLength(0);
  });

  test("a missing file is the gateway's 404", async () => {
    const { gateway } = gatewayWith({});
    const response = await appFor(gateway).request(
      `${base}/text?path=gone.txt`,
    );
    expect(response.status).toBe(404);
  });
});

describe("who may preview", () => {
  const allowed = {
    channelFor: async (_actor: AgentActor, id: string) =>
      id === "channel-1"
        ? { agentIds: ["bot-17"], threadIds: ["thread-1"] }
        : null,
    runOf: async (_actor: AgentActor, _channel: string, run: string) =>
      run === "run-1"
        ? {
            threadId: "thread-1",
            ownerId: "owner-1",
            agentId: "bot-17",
            events: [
              {
                type: "CUSTOM",
                name: "computer.turn_artifacts",
                value: {
                  botId: "bot-17",
                  seat: "person:owner-1",
                  files: [
                    { path: "报告 #1?.pptx" },
                    { path: "notes.md" },
                    { path: "page.html" },
                  ],
                },
              },
            ] as unknown as BaseEvent[],
          }
        : null,
    cardFor: async () => null,
    seatFor: async (botId: string, personId: string) =>
      personSeat(personId, botId),
    botIsLive: async () => true,
  } satisfies ArtifactAccessDeps;

  const scope = "channel=channel-1&run=run-1";

  test.each(["preview", "text"])(
    "%s: a member who may not use the Bot reads what the run announced, from the announced seat",
    async (route) => {
      const seats: unknown[] = [];
      const { gateway, calls } = gatewayWith({
        files: { "notes.md": bytesOf("hi"), "page.html": bytesOf("<p>") },
      });
      const asked = gateway.downloadFile.bind(gateway);
      gateway.downloadFile = (seat, ...rest) => {
        seats.push(seat);
        return asked(seat, ...rest);
      };
      const path = route === "preview" ? "page.html" : "notes.md";
      const response = await appFor(
        gateway,
        async () => false,
        allowed,
      ).request(`${base}/${route}?${scope}&path=${encode(path)}`);

      expect(response.status).toBe(200);
      expect(seats).toEqual([personSeat("owner-1", "bot-17")]);
      expect(calls.downloads.map((call) => call.path)).toEqual([path]);
    },
  );

  test("an Office file named by the run is converted on the announced seat", async () => {
    const seats: unknown[] = [];
    const { gateway, calls } = gatewayWith({ pdf: { bytes: bytesOf("%PDF") } });
    const converted = gateway.previewPdf.bind(gateway);
    gateway.previewPdf = (seat, ...rest) => {
      seats.push(seat);
      return converted(seat, ...rest);
    };
    const response = await appFor(gateway, async () => false, allowed).request(
      `${base}/preview?${scope}&path=${encode("报告 #1?.pptx")}`,
    );
    expect(response.status).toBe(200);
    expect(seats).toEqual([personSeat("owner-1", "bot-17")]);
    expect(calls.pdfs.map((call) => call.path)).toEqual(["报告 #1?.pptx"]);
  });

  test.each(["preview", "text"])(
    "%s: any scope that does not hold is 404, whatever the type, and the gateway is never called",
    async (route) => {
      const { gateway, calls } = gatewayWith({
        files: { "notes.md": bytesOf("hi"), "other.md": bytesOf("hi") },
        pdf: { bytes: bytesOf("%PDF") },
      });
      for (const query of [
        `${scope}&path=other.md`,
        `channel=channel-1&run=run-9&path=notes.md`,
        `channel=channel-9&run=run-1&path=notes.md`,
        `channel=channel-1&path=notes.md`,
        `channel=&run=&path=notes.md`,
        `task=&path=notes.md`,
        `${scope}&path=..%2Fnotes.md`,
        `${scope}`,
        // a type the route would refuse still answers as a missing Bot, not as 415
        `${scope}&path=logo.svg`,
      ]) {
        const response = await appFor(
          gateway,
          async () => true,
          allowed,
        ).request(`${base}/${route}?${query}`);
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
          error: "There is no such Bot.",
        });
      }
      expect(calls.downloads).toHaveLength(0);
      expect(calls.pdfs).toHaveLength(0);
    },
  );

  test.each(["preview", "text"])(
    "%s: a router wired without the rules refuses every scoped request",
    async (route) => {
      const { gateway, calls } = gatewayWith({
        files: { "notes.md": bytesOf("hi") },
      });
      const response = await appFor(gateway).request(
        `${base}/${route}?${scope}&path=notes.md`,
      );
      expect(response.status).toBe(404);
      expect(calls.downloads).toHaveLength(0);
    },
  );

  test.each(["preview", "text"])(
    "%s: without a scope the Bot guard decides, and a refusal never reaches the gateway",
    async (route) => {
      const { gateway, calls } = gatewayWith({
        files: { "a.md": bytesOf("hi"), "a.png": bytesOf("x") },
      });
      const asked: string[] = [];
      const denied = await appFor(gateway, async (_actor, botId) => {
        asked.push(botId);
        return false;
      }).request(
        `${base}/${route}?path=${route === "text" ? "a.md" : "a.png"}`,
      );

      expect(denied.status).toBe(404);
      await expect(denied.json()).resolves.toEqual({
        error: "There is no such Bot.",
      });
      expect(asked).toEqual(["bot-17"]);
      expect(calls.downloads).toHaveLength(0);

      const allowedResponse = await appFor(gateway).request(
        `${base}/${route}?path=${route === "text" ? "a.md" : "a.png"}`,
      );
      expect(allowedResponse.status).toBe(200);
      expect(calls.downloads).toHaveLength(1);
    },
  );

  test.each(["preview", "text"])(
    "%s: an employee that no longer exists is a 404 and the gateway is never asked",
    async (route) => {
      const { gateway, calls } = gatewayWith({
        files: { "notes.md": bytesOf("hi") },
        pdf: { bytes: bytesOf("%PDF") },
      });
      const response = await appFor(gateway, async () => true, {
        ...allowed,
        botIsLive: async () => false,
      }).request(`${base}/${route}?${scope}&path=notes.md`);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "There is no such Bot.",
      });
      expect(calls.downloads).toHaveLength(0);
      expect(calls.pdfs).toHaveLength(0);
    },
  );

  test("a scope on a scoped route never falls back to the person's own Bot", async () => {
    const { gateway, calls } = gatewayWith({
      files: { "notes.md": bytesOf("hi") },
    });
    const response = await appFor(gateway, async () => true, allowed).request(
      `${base}/text?channel=channel-1&path=notes.md`,
    );
    expect(response.status).toBe(404);
    expect(calls.downloads).toHaveLength(0);
  });

  test.each([
    "http://xiongbao.test/bot-17/files/preview/x",
    "http://xiongbao.test/bot-17/other/files/preview",
    "http://xiongbao.test/bot-17/files/previews",
    "http://xiongbao.test/bot-17/status",
    "http://xiongbao.test/bot-17/files/list",
  ])("the scope does not open %s", async (url) => {
    const { gateway } = gatewayWith({ files: { "notes.md": bytesOf("hi") } });
    const response = await appFor(gateway, async () => false, allowed).request(
      `${url}${url.includes("?") ? "&" : "?"}${scope}&path=notes.md`,
    );
    expect(response.status).toBe(404);
  });

  test("the guard step-aside is exact: another Bot's segment before files does not match", async () => {
    const { gateway, calls } = gatewayWith({
      files: { "notes.md": bytesOf("hi") },
    });
    const asked: string[] = [];
    const response = await appFor(
      gateway,
      async (_actor, botId) => {
        asked.push(botId);
        return false;
      },
      allowed,
    ).request(
      `http://xiongbao.test/bot-17/files/text/files/text?${scope}&path=notes.md`,
    );
    expect(response.status).toBe(404);
    expect(asked).toEqual(["bot-17"]);
    expect(calls.downloads).toHaveLength(0);
  });
});

describe("what is not a file is still private", () => {
  const privateHeaders = (response: Response) => {
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  };

  test.each(["preview", "text"])(
    "%s: a 415, a missing path, a refused Bot and a failed read carry both headers",
    async (route) => {
      const kindless = route === "preview" ? "a.txt" : "a.png";
      const { gateway } = gatewayWith({ files: { [kindless]: bytesOf("x") } });
      privateHeaders(
        await appFor(gateway).request(`${base}/${route}?path=${kindless}`),
      );
      privateHeaders(await appFor(gateway).request(`${base}/${route}`));
      privateHeaders(
        await appFor(gateway, async () => false).request(
          `${base}/${route}?path=${kindless}`,
        ),
      );
      const ok = route === "preview" ? "gone.png" : "gone.txt";
      const missing = await appFor(gateway).request(
        `${base}/${route}?path=${ok}`,
      );
      expect(missing.status).toBe(404);
      privateHeaders(missing);
    },
  );

  test("the `unavailable` answer carries both headers", async () => {
    const { gateway } = gatewayWith({ pdf: { unavailable: true } });
    const response = await appFor(gateway).request(
      `${base}/preview?path=a.docx`,
    );
    expect(response.status).toBe(200);
    privateHeaders(response);
  });

  test("a scoped refusal carries both headers", async () => {
    const { gateway } = gatewayWith({});
    const response = await appFor(gateway).request(
      `${base}/preview?channel=c&run=r&path=a.png`,
    );
    expect(response.status).toBe(404);
    privateHeaders(response);
  });

  test("every inline response may be framed by this application only", async () => {
    const { gateway } = gatewayWith({
      files: { "a.html": bytesOf("x"), "a.pdf": bytesOf("x") },
      pdf: { bytes: bytesOf("%PDF") },
    });
    for (const name of ["a.html", "a.pdf", "a.docx"]) {
      const response = await appFor(gateway).request(
        `${base}/preview?path=${encode(name)}`,
      );
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'self'",
      );
    }
  });
});

describe("the download route still maps a seat failure as before", () => {
  test("a computer that cannot be found answers 503, not an unhandled error", async () => {
    const { gateway } = gatewayWith({});
    gateway.seatFor = async () => {
      throw new ComputerUnavailableError("The computer is not running.");
    };
    for (const route of ["download", "preview", "text"]) {
      const response = await appFor(gateway).request(
        `${base}/${route}?path=a.txt`,
      );
      expect(response.status).toBe(503);
    }
  });
});

describe("a stream shorter than its declared length", () => {
  test("is not truncated and gains no replacement character", async () => {
    const { gateway } = gatewayWith({
      files: { "a.txt": bytesOf("你好") },
      declared: { "a.txt": TEXT_PREVIEW_BYTES * 2 },
    });
    const response = await appFor(gateway).request(`${base}/text?path=a.txt`);
    const body = (await response.json()) as {
      text: string;
      truncated: boolean;
      bytes: number;
    };
    expect(body.text).toBe("你好");
    expect(body.truncated).toBe(false);
    expect(body.bytes).toBe(TEXT_PREVIEW_BYTES * 2);
  });
});

/*
 * A confined workspace (COMPUTER_PER_BOT_USERS=on, an employee other than the default one) streams
 * the file from the descriptor it checked, and Bun answers that stream chunked, without
 * Content-Length. The computer states the length in FILE_BYTES_HEADER instead. Here the gateway's
 * download goes through the real transport, so what the routes get is what `client.ts` makes of such
 * an answer: the length it states, and a body held to exactly that length.
 */
describe("a confined computer's download, sent chunked with its length in a header", () => {
  function chunkedAnswer(
    name: string,
    bytes: Uint8Array,
    stated: number = bytes.byteLength,
  ) {
    const upstream = streamOf(bytes, 4);
    const headers = computerDownloadHeaders(name, stated);
    delete headers["Content-Length"];
    return {
      response: new Response(upstream.stream, { headers }),
      state: upstream.state,
    };
  }

  function gatewayOverTransport(
    answer: (path: string) => Response,
  ): ComputerGateway {
    const transport = createComputerTransport({
      fetchImpl: (async (url: string) =>
        answer(
          new URL(url).searchParams.get("path") ?? "",
        )) as unknown as typeof fetch,
    });
    // As gateway.ts does it, less the decision and the audit row.
    return {
      seatFor: async (botId: string, personId: string) =>
        personSeat(personId, botId),
      downloadFile: async (
        _seat: unknown,
        _actor: unknown,
        input: { path: string },
        signal?: AbortSignal,
      ) => ({
        ...(await transport.download(
          "http://agent-computer:4100",
          "bot-17",
          `/files/download?path=${encodeURIComponent(input.path)}`,
          signal,
        )),
        name: input.path.split("/").pop() ?? "download",
      }),
    } as unknown as ComputerGateway;
  }

  test("the answer itself has no Content-Length, only the stated length", () => {
    const { response } = chunkedAnswer("a.txt", bytesOf("hello"));
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get(FILE_BYTES_HEADER)).toBe("5");
  });

  test("the text preview reads it", async () => {
    const text = "第一行\n第二行\n第三行\n";
    const gateway = gatewayOverTransport(
      (path) => chunkedAnswer(path, bytesOf(text)).response,
    );
    const response = await appFor(gateway).request(
      `${base}/text?path=${encode("测试-test.txt")}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "text",
      text,
      truncated: false,
      bytes: bytesOf(text).byteLength,
    });
  });

  test("the inline preview serves it with its length", async () => {
    const html = "<p>hello</p>";
    const gateway = gatewayOverTransport(
      (path) => chunkedAnswer(path, bytesOf(html)).response,
    );
    const response = await appFor(gateway).request(
      `${base}/preview?path=${encode("site/index.html")}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(
      String(bytesOf(html).byteLength),
    );
    expect(await response.text()).toBe(html);
  });

  test("the download serves it with its length", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 255]);
    const gateway = gatewayOverTransport(
      (path) => chunkedAnswer(path, bytes).response,
    );
    const response = await appFor(gateway).request(
      `${base}/download?path=${encode("out/data.bin")}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test("a body that runs past the stated length is refused, and the computer's stream cancelled", async () => {
    const states: Array<{ cancelled: boolean; pulled: number }> = [];
    const gateway = gatewayOverTransport((path) => {
      const answer = chunkedAnswer(path, bytesOf("0123456789"), 6);
      states.push(answer.state);
      return answer.response;
    });

    const text = await appFor(gateway).request(`${base}/text?path=a.txt`);
    expect(text.status).toBe(503);
    expect(await text.json()).toEqual({
      error: "The Bot's computer sent back a file that couldn't be read.",
    });

    const download = await appFor(gateway).request(
      `${base}/download?path=a.bin`,
    );
    // The headers are already on their way; the body is cut off rather than overrun.
    await expect(download.arrayBuffer()).rejects.toThrow("couldn't be read");

    const preview = await appFor(gateway).request(`${base}/preview?path=a.png`);
    await expect(preview.arrayBuffer()).rejects.toThrow("couldn't be read");

    expect(states.map((state) => state.cancelled)).toEqual([true, true, true]);
  });

  test("a body that ends short of the stated length is refused", async () => {
    const gateway = gatewayOverTransport(
      (path) => chunkedAnswer(path, bytesOf("0123"), 10).response,
    );
    const text = await appFor(gateway).request(`${base}/text?path=a.txt`);
    expect(text.status).toBe(503);
    const download = await appFor(gateway).request(
      `${base}/download?path=a.bin`,
    );
    await expect(download.arrayBuffer()).rejects.toThrow("couldn't be read");
  });

  test("a stated length that disagrees with Content-Length is refused before any route answers", async () => {
    const gateway = gatewayOverTransport(
      () =>
        new Response(bytesOf("hello"), {
          headers: {
            ...computerDownloadHeaders("a.txt", 5),
            [FILE_BYTES_HEADER]: "4",
          },
        }),
    );
    for (const route of ["download", "preview", "text"]) {
      const name = route === "preview" ? "a.png" : "a.txt";
      const response = await appFor(gateway).request(
        `${base}/${route}?path=${name}`,
      );
      expect(response.status).toBe(503);
    }
  });
});
