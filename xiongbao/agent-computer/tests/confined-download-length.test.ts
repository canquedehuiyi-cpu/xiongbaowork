import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerTransport } from "../../server/src/computer/client";
import {
  computerDownloadHeaders,
  FILE_BYTES_HEADER,
} from "../../shared/file-download";
import { createWorkspace, DEFAULT_WORKSPACE_LIMITS } from "../src/workspace";

/**
 * 复现：产物预览 503「The Bot's computer sent back a file that couldn't be read.」
 *
 * 镜像默认 COMPUTER_PER_BOT_USERS=on，非默认员工的工作区是「confined」的（per-bot.ts 的
 * `confineOpened: true`）。这时 `download` 交出的是一个异步 pull 的 ReadableStream
 * （workspace.ts 的 `downloadOpened`），Bun 回应这种 body 时丢掉了显式写的 Content-Length、改用
 * chunked。服务器的 `transport.download`（server/src/computer/client.ts）要求 Content-Length，
 * 没有就抛 ComputerUnavailableError → 路由答 503。与文件名是否含中文无关。
 *
 * 修法：电脑端在 `FILE_BYTES_HEADER` 里另报一次长度（`computerDownloadHeaders`），Bun 丢不掉它；
 * 服务器没有 Content-Length 时按这个长度逐字节核对，多一个字节或少一个字节都拒绝。
 *
 * 下面的服务端照抄 agent-computer/src/index.ts 的 `/files/download` 分支。
 */

let root = "";
let server: ReturnType<typeof Bun.serve> | undefined;

function serve(confined: boolean, afterOpen?: () => Promise<void>) {
  const files = createWorkspace(root, DEFAULT_WORKSPACE_LIMITS, {
    confineOpened: confined,
  });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const file = await files.download(url.searchParams.get("path") ?? "");
      await afterOpen?.();
      return new Response(file.body, {
        headers: computerDownloadHeaders(file.name, file.bytes),
      });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "confined-download-"));
  await writeFile(join(root, "测试-test.txt"), "第一行\n第二行\n第三行\n");
  await writeFile(join(root, "test.txt"), "a\nb\nc\n");
});

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

describe.each([
  ["shared (COMPUTER_PER_BOT_USERS=off)", false],
  ["confined (COMPUTER_PER_BOT_USERS=on, non-default employee)", true],
] as const)("a download from a %s workspace", (_label, confined) => {
  for (const name of ["测试-test.txt", "test.txt"]) {
    test(`${name}: announces its length`, async () => {
      const base = serve(confined);
      const response = await fetch(
        `${base}/files/download?path=${encodeURIComponent(name)}`,
      );
      expect(response.status).toBe(200);
      const size = String(Buffer.byteLength(contentsOf(name)));
      // Bun drops Content-Length for the confined stream; the length header is always there.
      expect(response.headers.get(FILE_BYTES_HEADER)).toBe(size);
      const length = response.headers.get("content-length");
      if (length !== null) expect(length).toBe(size);
      await response.body?.cancel();
    });

    test(`${name}: the server's transport can read it`, async () => {
      const base = serve(confined);
      const transport = createComputerTransport({});
      const download = await transport.download(
        base,
        "agent_test",
        `/files/download?path=${encodeURIComponent(name)}`,
      );
      expect(download.bytes).toBe(Buffer.byteLength(contentsOf(name)));
      expect(await new Response(download.body).text()).toBe(contentsOf(name));
    });
  }

  test("a file of many chunks arrives whole", async () => {
    const big = Buffer.alloc(300 * 1024 + 7, 0x61);
    await writeFile(join(root, "big.bin"), big);
    const base = serve(confined);
    const download = await createComputerTransport({}).download(
      base,
      "agent_test",
      "/files/download?path=big.bin",
    );
    expect(download.bytes).toBe(big.byteLength);
    const got = new Uint8Array(await new Response(download.body).arrayBuffer());
    expect(got.byteLength).toBe(big.byteLength);
  });
});

describe("a confined download whose file changes after it was opened", () => {
  test("a file that grew sends no more than the length announced", async () => {
    const base = serve(true, () => appendFile(join(root, "test.txt"), "more"));
    const download = await createComputerTransport({}).download(
      base,
      "agent_test",
      "/files/download?path=test.txt",
    );
    expect(download.bytes).toBe(6);
    expect(await new Response(download.body).text()).toBe("a\nb\nc\n");
  });

  test("a file that shrank is refused, not handed on as a whole file", async () => {
    // Larger than one 64 KiB read, so that most of it is read after the file was cut short.
    const size = 200 * 1024;
    await writeFile(join(root, "big.bin"), Buffer.alloc(size, 0x61));
    const base = serve(true, () => truncate(join(root, "big.bin"), 1000));
    const download = await createComputerTransport({}).download(
      base,
      "agent_test",
      "/files/download?path=big.bin",
    );
    expect(download.bytes).toBe(size);
    await expect(new Response(download.body).arrayBuffer()).rejects.toThrow(
      "couldn't be read",
    );
  });
});

function contentsOf(name: string): string {
  return name === "test.txt" ? "a\nb\nc\n" : "第一行\n第二行\n第三行\n";
}
