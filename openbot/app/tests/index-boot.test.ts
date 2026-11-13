import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The inline pre-paint script in index.html cannot import anything, so it is run here as the browser
 * would run it, against a fake window and document, to pin the two things it must do with the keys a
 * browser from before the rename left behind.
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

function boot(stored: Record<string, string>) {
  const data = new Map(Object.entries(stored));
  const localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  const dataset: Record<string, string> = {};
  const classes = new Set<string>();
  const documentElement = {
    dataset,
    style: { colorScheme: "" },
    classList: {
      toggle: (name: string, on: boolean) =>
        void (on ? classes.add(name) : classes.delete(name)),
    },
  };
  new Function("window", "document", script)(
    { localStorage },
    { documentElement },
  );
  return { data, dataset, classes };
}

test("the inline script is found", () => {
  expect(script).toContain("dataset.skin");
});

test("a cached skin under the old default's name is the default: no data-skin is set", () => {
  const { dataset } = boot({ "openbot-skin": "openbot" });
  expect(dataset.skin).toBeUndefined();
  expect(boot({ "xiongbao-skin": "xiongbao" }).dataset.skin).toBeUndefined();
  expect(boot({ "xiongbao-skin": "openduet" }).dataset.skin).toBe("openduet");
});

test("a value under an old key is copied to the new key, and the old key is kept", () => {
  const { data, classes } = boot({
    "openbot-theme": "dark",
    "openbot-skin": "opendots",
  });
  expect(data.get("xiongbao-theme")).toBe("dark");
  expect(data.get("openbot-theme")).toBe("dark");
  expect(data.get("xiongbao-skin")).toBe("opendots");
  expect(data.get("openbot-skin")).toBe("opendots");
  expect(classes.has("dark")).toBe(true);
});
