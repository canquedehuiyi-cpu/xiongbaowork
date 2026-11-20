/** 判分脚本单元测试的共用小工具：在临时目录里摆出「做完后的目录」。 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  copyTree,
  GOLD_DIR,
  materialize,
  sourceTask,
  type TaskName,
} from "./lib";

const made: string[] = [];

export function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-empty-"));
  made.push(dir);
  return dir;
}

/** 夹具原样落地（还没做题）。 */
export function untouched(task: TaskName, vars: Record<string, string> = {}) {
  const dir = emptyDir();
  materialize(task, dir, vars);
  return dir;
}

/** 夹具落地后叠上 gold/<task>/ 里的标准答案。 */
export function solved(task: TaskName, vars: Record<string, string> = {}) {
  const dir = untouched(task, vars);
  copyTree(join(GOLD_DIR, sourceTask(task)), dir, true);
  return dir;
}

export function write(dir: string, path: string, contents: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), contents);
}

export function cleanup() {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

export const failed = (outcome: { checks: { name: string; ok: boolean }[] }) =>
  outcome.checks.filter((item) => !item.ok).map((item) => item.name);
