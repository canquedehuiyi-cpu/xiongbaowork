import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Nothing a Helm or Compose deployment runs knows the upstream desktop app's update feed. A server,
 * worker or page that named it would be a self-hosted deployment reaching downloads.copilotkit.ai,
 * which is never wanted.
 */
test("no code a self-hosted deployment runs names the upstream desktop update feed", () => {
  const root = join(import.meta.dir, "..", "..");
  const shipped = [
    "app/src",
    "server/src",
    "worker",
    "shared",
    "supervisor",
    "charts",
    "docker",
    "docker-compose.yml",
    "Dockerfile",
  ];
  const named: string[] = [];
  const visit = (path: string) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        visit(join(path, entry));
      }
      return;
    }
    if (readFileSync(path, "utf8").includes("downloads.copilotkit.ai"))
      named.push(path.slice(root.length + 1));
  };
  for (const part of shipped) visit(join(root, part));
  expect(named).toEqual([]);
});
