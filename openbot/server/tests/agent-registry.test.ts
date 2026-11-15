import { expect, test } from "bun:test";
import { createAgentRegistry } from "../src/agents/registry";

test("reports built-in and remote agent availability without secrets", () => {
  expect(
    createAgentRegistry(
      [
        {
          id: "knowledge",
          name: "Knowledge",
          type: "built_in",
          credentialRef: "openai",
        },
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "https://risk.example/ag-ui",
        },
      ],
      new Set(["openai"]),
    ),
  ).toEqual([
    { id: "knowledge", name: "Knowledge", type: "built_in", available: true },
    { id: "risk", name: "Risk", type: "remote_ag_ui", available: true },
  ]);
});

test("marks unavailable agents with safe reasons", () => {
  expect(
    createAgentRegistry(
      [
        {
          id: "knowledge",
          name: "Knowledge",
          type: "built_in",
          credentialRef: "openai",
        },
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "ftp://risk.example",
        },
      ],
      new Set(),
    ),
  ).toEqual([
    {
      id: "knowledge",
      name: "Knowledge",
      type: "built_in",
      available: false,
      reason: "Model credential is not configured.",
    },
    {
      id: "risk",
      name: "Risk",
      type: "remote_ag_ui",
      available: false,
      reason: "AG-UI endpoint is invalid.",
    },
  ]);
});

test("an external employee is available by its computer, not an address", () => {
  expect(
    createAgentRegistry(
      [
        { id: "coder", name: "小码", type: "device_acp", deviceId: "laptop" },
        { id: "lost", name: "丢了", type: "device_acp", deviceId: "" },
      ],
      new Set(),
    ),
  ).toEqual([
    { id: "coder", name: "小码", type: "device_acp", available: true },
    {
      id: "lost",
      name: "丢了",
      type: "device_acp",
      available: false,
      reason: "No computer is set for this external employee.",
    },
  ]);
});
