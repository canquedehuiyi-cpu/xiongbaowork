/**
 * Windows names 熊宝's publisher as XiongBao, on every build.
 *
 * Upstream's v0.3.3 installer listed the publisher as "copilotkit" because tauri.conf.json set no
 * `bundle.publisher`, and Tauri fell back to the identifier's second segment, both for the NSIS
 * installer's `Publisher` uninstall value (its `MANUFACTURER`) and for the app's `CompanyName`
 * version resource (tauri-build). This fork's identifier is `com.xiongbao.desktop`, so its earlier
 * installers named "xiongbao" the same way, and kept the install folder under
 * `Software\xiongbao\<product>`, which the installer reads back on every update. Windows registry keys
 * ignore case, so XiongBao is the same key, and a different name would lose the folder an update
 * installs into.
 *
 * The copyright stays upstream's (CopilotKit), so unlike upstream the publisher is not asserted to
 * match it.
 *
 * Plain file reads only, so it runs on any runner.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const tauri = join(import.meta.dir, "..", "src-tauri");
const readJson = (file: string) =>
  JSON.parse(readFileSync(join(tauri, file), "utf8"));

type Json = Record<string, unknown>;
type Config = {
  identifier: string;
  bundle: { publisher?: string; copyright?: string };
};

/** RFC 7396 merge, as `tauri build --config` lays an overlay on tauri.conf.json. */
function merge(base: unknown, patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    return patch;
  const out: Json =
    typeof base === "object" && base !== null && !Array.isArray(base)
      ? { ...(base as Json) }
      : {};
  for (const [key, value] of Object.entries(patch as Json)) {
    if (value === null) delete out[key];
    else out[key] = merge(out[key], value);
  }
  return out;
}

/** What Tauri writes as the publisher: `bundle.publisher`, else the identifier's second segment. */
const publisherOf = (config: Config) =>
  config.bundle.publisher ??
  config.identifier.split(".")[1] ??
  config.identifier;

const base = readJson("tauri.conf.json");
const builds: Record<string, Config> = {
  "desktop CI": base,
  "Windows signing": merge(
    base,
    readJson("tauri.windows-signing.conf.json"),
  ) as Config,
  "Mac signing": merge(
    base,
    readJson("tauri.macos-signing.conf.json"),
  ) as Config,
};

for (const [build, config] of Object.entries(builds)) {
  test(`the ${build} build names XiongBao as the publisher`, () => {
    expect(publisherOf(config)).toBe("XiongBao");
  });

  test(`the ${build} build keeps the identifier and the registry key an update reads`, () => {
    // Updates and app data are keyed on the identifier.
    expect(config.identifier).toBe("com.xiongbao.desktop");
    // Earlier installers kept their folder under Software\xiongbao, the identifier's second segment.
    // Registry keys ignore case.
    expect(publisherOf(config).toLowerCase()).toBe(
      config.identifier.split(".")[1],
    );
  });
}
