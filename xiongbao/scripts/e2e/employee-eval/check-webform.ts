/**
 * 判分：网页表单题（加难题，电脑操作：读页面、分两步填表、读成功页上的回执号）。
 *
 * 判分不信员工的自述，读服务端收到的记录（评测脚本做完后写进目录的 `.webform-received.json`，见
 * `webform-site.ts`）和员工写的 `receipt.txt`：
 *
 * - 有服务端的记录；
 * - 服务端接受了一次、也只接受了一次登记（重复登记会被系统拒绝，拒绝的尝试不算接受）；
 * - 接受下来的每个字段与 `onboarding.md` 里有效的资料一致（作废的旧手机号、不要的 16 寸、日期格式都在里面设了坑）；
 * - `receipt.txt` 里是服务端发出的那个回执号（读了成功页才写得出来，编不出）。
 */

import { join } from "node:path";
import { type Check, check, readText, result, runCheckCli } from "./lib";
import { type Received, RECEIVED_FILE } from "./webform-site";

/** `onboarding.md` 里有效的资料，写成服务端存下来的样子。 */
export const WEBFORM_GOLD = {
  full_name: "周明远",
  work_email: "zhou.mingyuan@example.test",
  department: "mkt",
  start_date: "2026-12-07",
  laptop: "mac14",
  monitor: "yes",
  emergency_name: "周丽华",
  emergency_phone: "13800002468",
} as const;

function readReceived(dir: string): Received | null {
  const text = readText(join(dir, RECEIVED_FILE));
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<Received>;
    return Array.isArray(value.accepted) && Array.isArray(value.attempts)
      ? (value as Received)
      : null;
  } catch {
    return null;
  }
}

export function checkWebform(dir: string) {
  const received = readReceived(dir);
  const checks: Check[] = [
    check(
      "读到了服务端收到的记录",
      received !== null,
      received === null ? `没有可读的 ${RECEIVED_FILE}` : "",
    ),
  ];
  const accepted = received?.accepted ?? [];
  checks.push(
    check(
      "服务端接受了一次、也只接受了一次登记",
      accepted.length === 1,
      received ? `接受 ${accepted.length} 次` : "",
    ),
  );

  const fields = accepted[0]?.fields ?? {};
  const wrong = Object.entries(WEBFORM_GOLD)
    .filter(([name, want]) => fields[name] !== want)
    .map(
      ([name, want]) =>
        `${name}：收到「${fields[name] ?? "（空）"}」，应为「${want}」`,
    );
  checks.push(
    check(
      "接受下来的资料与有效资料一致",
      accepted.length > 0 && wrong.length === 0,
      accepted.length ? wrong.join("；") : "没有被接受的登记",
    ),
  );

  const receipt = accepted[0]?.receipt ?? "";
  const written = (readText(join(dir, "receipt.txt")) ?? "").trim();
  checks.push(
    check(
      "receipt.txt 里是服务端发出的回执号",
      receipt !== "" && written === receipt,
      readText(join(dir, "receipt.txt")) === null
        ? "没有 receipt.txt"
        : receipt === ""
          ? "没有可对的回执号"
          : `写的是「${written.slice(0, 40)}」`,
    ),
  );
  return result("webform", checks);
}

if (import.meta.main) await runCheckCli("webform", checkWebform);
