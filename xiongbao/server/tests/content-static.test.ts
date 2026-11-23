import { describe, expect, test } from "bun:test";
import { resolveServedPath, serveStatic } from "../src/content/static";
import type { ContentGrant } from "../src/content/token";

type Dir = ContentGrant & { target: { kind: "dir"; path: string } };
const grant = (path = "site"): Dir => ({
  person: "p1",
  bot: "b1",
  seat: "person:p1",
  target: { kind: "dir", path },
  exp: 1,
});

const stream = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return {
    body: new Response(bytes).body as ReadableStream<Uint8Array>,
    bytes: bytes.length,
  };
};

/** A gateway that serves `files` by workspace path and records what was asked. */
function fake(files: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    serveFile: async (_seat: unknown, input: { path: string }) => {
      asked.push(input.path);
      const found = files[input.path];
      return found === undefined ? null : stream(found);
    },
  };
}

const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals";

describe("resolveServedPath", () => {
  test.each([
    "../x",
    "a/../../x",
    "a/..",
    "a\\..\\x",
    "a\\b",
    "%2e%2e/x",
    "%2E%2E%2Fx",
    "a%00b",
    "/etc/passwd",
    "//etc/passwd",
    "%2Fetc/passwd",
    "%E0%A4%A",
  ])("refuses %s", (rel) => {
    expect(resolveServedPath("site", rel)).toBeNull();
  });

  test.each([
    ".git/config",
    ".env",
    "a/.env",
    ".xb-preview/x.pdf",
    "a/.hidden/b.html",
    "%2egit/config",
  ])("refuses the hidden segment in %s", (rel) => {
    expect(resolveServedPath("site", rel)).toBeNull();
  });

  test("a dot inside a name is fine", () => {
    expect(resolveServedPath("site", "a.b/c.d.js")).toBe("site/a.b/c.d.js");
  });

  test("index and decoding", () => {
    expect(resolveServedPath("site", "")).toBe("site/index.html");
    expect(resolveServedPath("site", "docs/")).toBe("site/docs/index.html");
    expect(resolveServedPath("site", "a%20b/%E6%8A%A5%E5%91%8A.html")).toBe(
      "site/a b/报告.html",
    );
  });

  test("repeated slashes collapse", () => {
    expect(resolveServedPath("site", "a//b///c.js")).toBe("site/a/b/c.js");
    expect(resolveServedPath("site", "a//")).toBe("site/a/index.html");
  });

  test("decodes once: %252e%252e is a literal directory name, never a parent", () => {
    // One decode gives the text "%2e%2e", an ordinary (odd) name. The computer does not decode a
    // path again, so it cannot turn into "..".
    expect(resolveServedPath("site", "%252e%252e/x.js")).toBe(
      "site/%2e%2e/x.js",
    );
  });

  test("an encoded slash becomes a separator and cannot escape", () => {
    expect(resolveServedPath("site", "a%2Fb.js")).toBe("site/a/b.js");
    expect(resolveServedPath("site", "a%2F..%2F..%2Fx")).toBeNull();
    expect(resolveServedPath("site", "a%5Cb")).toBeNull();
  });

  test("the folder itself is checked too", () => {
    for (const dir of [
      "",
      "/abs",
      "../x",
      "a/../x",
      "a\\b",
      "a\0b",
      ".git",
      "site/.secret",
    ]) {
      expect(resolveServedPath(dir, "index.html")).toBeNull();
    }
    expect(resolveServedPath("a/b", "x.js")).toBe("a/b/x.js");
    expect(resolveServedPath("site/", "x.js")).toBe("site/x.js");
  });
});

describe("serveStatic", () => {
  test("serves a file with its type and the hardening headers", async () => {
    const gateway = fake({ "site/index.html": "<h1>hi</h1>" });
    const res = await serveStatic(grant(), "", gateway, undefined, "GET");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>hi</h1>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(SANDBOX);
    expect(gateway.asked).toEqual(["site/index.html"]);
  });

  test("the type comes from the extension; unknown is octet-stream", async () => {
    const gateway = fake({ "site/a.png": "x", "site/a.weird": "x" });
    const png = await serveStatic(grant(), "a.png", gateway, undefined, "GET");
    expect(png.headers.get("content-type")).toBe("image/png");
    const odd = await serveStatic(
      grant(),
      "a.weird",
      gateway,
      undefined,
      "GET",
    );
    expect(odd.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("scripts and stylesheets get types a browser will run under nosniff", async () => {
    const gateway = fake({ "site/a.js": "x", "site/a.css": "x" });
    const js = await serveStatic(grant(), "a.js", gateway, undefined, "GET");
    expect(js.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    const css = await serveStatic(grant(), "a.css", gateway, undefined, "GET");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  test("svg is served as svg and is sandboxed all the same", async () => {
    const gateway = fake({ "site/i.svg": "<svg/>" });
    const res = await serveStatic(grant(), "i.svg", gateway, undefined, "GET");
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe(SANDBOX);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("Chinese and spaced file names", async () => {
    const gateway = fake({ "site/a b/报告.html": "ok" });
    const res = await serveStatic(
      grant(),
      "a%20b/%E6%8A%A5%E5%91%8A.html",
      gateway,
      undefined,
      "GET",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("404 is plain, fixed, path-free and still sandboxed", async () => {
    const gateway = fake({});
    for (const rel of ["missing.js", "../x", "%E0%A4%A", ".env", "a%00b"]) {
      const res = await serveStatic(grant(), rel, gateway, undefined, "GET");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await res.text()).toBe("Not found");
      expect(res.headers.get("content-security-policy")).toBe(SANDBOX);
      expect(res.headers.get("content-security-policy")).not.toContain(
        "allow-same-origin",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
    // Nothing unsafe reached the computer.
    expect(gateway.asked).toEqual(["site/missing.js"]);
  });

  test("a folder asked for without a trailing slash is a plain 404, not a redirect", async () => {
    // The computer answers null for a folder; there is deliberately no redirect to "<rel>/".
    const res = await serveStatic(grant(), "docs", fake({}), undefined, "GET");
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  test("a bad folder in the grant is a 404 and asks nothing", async () => {
    const gateway = fake({ "x/index.html": "no" });
    const res = await serveStatic(grant("../x"), "", gateway, undefined, "GET");
    expect(res.status).toBe(404);
    expect(gateway.asked).toEqual([]);
  });

  test("a refusal by the computer reads as 404", async () => {
    const gateway = { serveFile: async () => null };
    const res = await serveStatic(grant(), "link", gateway, undefined, "GET");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  test("HEAD has headers and no body", async () => {
    const gateway = fake({ "site/index.html": "<h1>hi</h1>" });
    const res = await serveStatic(grant(), "", gateway, undefined, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(SANDBOX);
    expect(await res.text()).toBe("");
  });

  test("HEAD of a missing file is a 404 with no body", async () => {
    const res = await serveStatic(grant(), "n.js", fake({}), undefined, "HEAD");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  test("any other method is 405, sandboxed, and asks nothing", async () => {
    const gateway = fake({ "site/index.html": "x" });
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await serveStatic(grant(), "", gateway, undefined, method);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      expect(res.headers.get("content-security-policy")).toBe(SANDBOX);
    }
    expect(gateway.asked).toEqual([]);
  });

  test("a failure other than not-found is thrown, not hidden", async () => {
    const gateway = {
      serveFile: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      serveStatic(grant(), "a.js", gateway, undefined, "GET"),
    ).rejects.toThrow("boom");
  });
});
