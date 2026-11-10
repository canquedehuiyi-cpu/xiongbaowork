import { expect, test } from "bun:test";
import { approvalTargetName } from "../src/components/approvals/inline-approval";

/*
 * 审批卡片上的「目标」（上游 #1230）。主人电脑上的文件夹以前写成授权 id：
 * 「等你批准：write file，目标 host-grant-15407-1794112361547002000」。现在写文件夹名。
 */

test("a folder on the person's computer is named by its name, never its grant id", () => {
  expect(
    approvalTargetName({
      toolRef: "host/write_file",
      scope: "host-grant-15407-1794112361547002000",
      target: {
        grantId: "host-grant-15407-1794112361547002000",
        displayName: "folder-test",
        relativePath: "notes.txt",
      },
    }),
  ).toBe("folder-test");
});

test("a folder whose name was not recorded still does not show its grant id", () => {
  const named = approvalTargetName({
    toolRef: "host/run_command",
    scope: "host-grant-1",
    target: { grantId: "host-grant-1" },
  });
  expect(named).not.toContain("host-grant-");
  expect(named).toBe("你电脑上的文件夹");
});

test("every other action keeps the scope it always showed", () => {
  expect(
    approvalTargetName({
      toolRef: "computer_write_file",
      scope: "report.txt",
      target: { filePath: "report.txt" },
    }),
  ).toBe("report.txt");
  expect(
    approvalTargetName({
      toolRef: "notes/create_note",
      scope: "*",
      target: null,
    }),
  ).toBe("*");
});
