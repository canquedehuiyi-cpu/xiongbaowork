import { writeFileSync } from "node:fs";

const [origin, directory] = process.argv.slice(2);
let failures = 0;
function check(ok, name) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
}
const capabilities = await fetch(`${origin}/api/capabilities`);
check(capabilities.status === 200, "/api/capabilities 200");
const value = await capabilities.json();
check(value.selfHostBanner === false, "selfHostBanner=false");
// These routers are appended after createApp() returns. Probe the built image with APP_DIST_DIR
// active: individual router tests cannot detect a SPA fallback swallowing the business APIs.
for (const path of [
  "/api/tasks",
  "/api/models",
  "/api/quota",
  "/api/devices",
  "/api/waker-groups",
  "/api/group-pipelines/templates",
  "/api/personas",
  "/api/agents/general-assistant/autonomous",
]) {
  const api = await fetch(`${origin}${path}`);
  check(
    api.status === 200 &&
      api.headers.get("content-type")?.includes("application/json"),
    `${path} 200 JSON`,
  );
  check(Boolean(await api.json().catch(() => null)), `${path} parses as JSON`);
}
for (const path of ["/api", "/api/missing-delivery-route"]) {
  check((await fetch(`${origin}${path}`)).status === 404, `${path} stays 404`);
}
const response = await fetch(origin);
check(response.status === 200, "HTML 200");
const html = await response.text();
writeFileSync(`${directory}/index.html`, html);
check(
  html.includes("熊宝数字员工"),
  "HTML contains 熊宝数字员工 (C owns title)",
);
check(!html.includes("Self-host OpenBot"), "HTML excludes Self-host OpenBot");
const scripts = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)];
const entry = scripts.find(([, src]) => /\/assets\/index-[^/]+\.js$/.test(src));
check(Boolean(entry), "main JS entry exists");
if (entry) {
  const jsResponse = await fetch(new URL(entry[1], origin));
  check(jsResponse.status === 200, "main JS 200");
  const js = await jsResponse.text();
  writeFileSync(`${directory}/main.js`, js);
  check(js.includes("熊宝数字员工"), "main JS contains 熊宝数字员工");
  check(
    !js.includes("Self-host OpenBot"),
    "main JS excludes Self-host OpenBot (C owns visible strings)",
  );
}
process.exitCode = failures ? 1 : 0;
