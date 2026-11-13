/**
 * The sidecar build (scripts/build-sidecar.ts): the names Tauri's `externalBin` expects, the Bun
 * target for each platform, and the stage 0 flags. Compiling the runner itself is proven by
 * runner/tests/runner-package.test.ts, with these same flags.
 */
import { expect, test } from "bun:test";
import {
  bunTargetFor,
  compileArgs,
  hostTriple,
  sidecarArgs,
  sidecarFile,
} from "../scripts/build-sidecar";

test("each platform's sidecar has the name externalBin looks for", () => {
  expect(sidecarFile("x86_64-unknown-linux-gnu")).toBe(
    "xiongbao-runner-x86_64-unknown-linux-gnu",
  );
  expect(sidecarFile("x86_64-pc-windows-msvc")).toBe(
    "xiongbao-runner-x86_64-pc-windows-msvc.exe",
  );
  expect(sidecarFile("aarch64-apple-darwin")).toBe(
    "xiongbao-runner-aarch64-apple-darwin",
  );
});

test("the Bun target follows the Rust triple, and an unknown one is refused", () => {
  expect(bunTargetFor("x86_64-pc-windows-msvc")).toBe("bun-windows-x64");
  expect(bunTargetFor("aarch64-apple-darwin")).toBe("bun-darwin-arm64");
  expect(bunTargetFor("x86_64-unknown-linux-gnu")).toBe("bun-linux-x64");
  expect(() => bunTargetFor("riscv64gc-unknown-linux-gnu")).toThrow(
    "No Bun target",
  );
});

test("the stage 0 flags are used, and --target only when cross-compiling", () => {
  const host = "x86_64-unknown-linux-gnu";
  const native = compileArgs(host, host, "/out/runner");
  expect(native.slice(0, 2)).toEqual(["build", "--compile"]);
  expect(native.some((arg) => arg.startsWith("--target"))).toBe(false);
  expect(native.at(2)).toMatch(/runner[\\/]src[\\/]index\.ts$/);
  expect(native.slice(3)).toEqual([
    "--external",
    "chromium-bidi",
    "--external",
    "chromium-bidi/*",
    "--outfile",
    "/out/runner",
  ]);
  expect(compileArgs("x86_64-pc-windows-msvc", host, "/o")).toContain(
    "--target=bun-windows-x64",
  );
});

test("compile args minify", () => {
  const host = "x86_64-unknown-linux-gnu";
  const args = sidecarArgs(host, host, "/out/runner");
  // Everything the stage 0 flags say stays, in the same order.
  expect(args.slice(0, compileArgs(host, host, "/out/runner").length)).toEqual(
    compileArgs(host, host, "/out/runner"),
  );
  expect(args).toContain("--minify");
  // playwright-core's __dirname/__filename would otherwise be written into the binary as the
  // build machine's absolute path.
  const defines = args.flatMap((arg, i) =>
    args[i - 1] === "--define" ? [arg] : [],
  );
  expect(defines.map((d) => d.split("=")[0]).sort()).toEqual([
    "__dirname",
    "__filename",
  ]);
});

test("the host triple is read from rustc -vV", () => {
  const output =
    "rustc 1.97.0 (2d8144b78 2026-07-07)\nbinary: rustc\nhost: x86_64-unknown-linux-gnu\nrelease: 1.97.0\n";
  expect(hostTriple(output)).toBe("x86_64-unknown-linux-gnu");
  expect(() => hostTriple("nothing")).toThrow();
});
