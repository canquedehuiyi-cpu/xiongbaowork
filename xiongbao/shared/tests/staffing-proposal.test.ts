import { describe, expect, test } from "bun:test";
import {
  isStaffingProposalTool,
  readStaffingProposalAnswer,
  STAFFING_PROPOSAL_MARKER,
  STAFFING_TOOL_NAMES,
  writeStaffingProposalAnswer,
} from "../staffing-proposal";

/**
 * 招聘提议的回答格式：服务端写、对话记录读。读的一边只认字段齐全的卡片，其余一律当成普通文字。
 */
describe("the staffing proposal answer", () => {
  test("a written answer reads back", () => {
    const card = {
      proposalId: "proposal-1",
      kind: "employee" as const,
      title: "小红书运营",
    };
    const text = writeStaffingProposalAnswer(card, "已起草，等你确认。");
    expect(text.startsWith(STAFFING_PROPOSAL_MARKER)).toBe(true);
    expect(readStaffingProposalAnswer(text)).toEqual({
      card,
      sentence: "已起草，等你确认。",
    });
  });

  test("a tampered marker reads as null", () => {
    const missingTitle = `${STAFFING_PROPOSAL_MARKER}${JSON.stringify({
      proposalId: "proposal-1",
      kind: "group",
    })}\n句子`;
    const unknownKind = `${STAFFING_PROPOSAL_MARKER}${JSON.stringify({
      proposalId: "proposal-1",
      kind: "everything",
      title: "群",
    })}\n句子`;
    const notJson = `${STAFFING_PROPOSAL_MARKER}{proposalId: 1\n句子`;
    expect(readStaffingProposalAnswer(missingTitle)).toBeNull();
    expect(readStaffingProposalAnswer(unknownKind)).toBeNull();
    expect(readStaffingProposalAnswer(notJson)).toBeNull();
    expect(readStaffingProposalAnswer("普通的回答")).toBeNull();
  });
});

describe("which tool calls draw a proposal card", () => {
  test("the four propose tools do, with or without the server prefix", () => {
    for (const name of [
      "propose_employee",
      "propose_employee_change",
      "propose_group",
      "propose_group_change",
    ]) {
      expect(isStaffingProposalTool(name)).toBe(true);
      expect(isStaffingProposalTool(`mcp__staffing__${name}`)).toBe(true);
    }
  });

  test("the reading tools and look-alikes do not", () => {
    expect(isStaffingProposalTool("list_staff")).toBe(false);
    expect(isStaffingProposalTool("mcp__staffing__proposal_status")).toBe(
      false,
    );
    expect(isStaffingProposalTool("mcp__other__propose_employee")).toBe(false);
    expect(isStaffingProposalTool("propose_employee_x")).toBe(false);
    expect(isStaffingProposalTool("")).toBe(false);
  });

  test("the six tool names are the published set", () => {
    expect([...STAFFING_TOOL_NAMES]).toEqual([
      "list_staff",
      "propose_employee",
      "propose_employee_change",
      "propose_group",
      "propose_group_change",
      "proposal_status",
    ]);
  });
});
