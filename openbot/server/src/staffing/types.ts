import type { Persona } from "../agents/profile-types";
import type { PortraitPreset } from "../portraits/store";

export type { PortraitPreset };

export type ProposalKind =
  | "employee"
  | "employee_change"
  | "group"
  | "group_change";

export type ProposalStatus =
  | "pending"
  | "applying"
  | "applied"
  | "partially_applied"
  | "discarded"
  | "expired";

export type RoutineDraft = {
  title?: string;
  instruction: string;
  cron: string;
  timezone?: string;
};

export type EmployeeDraft = {
  name: string;
  title: string;
  avatar?: { preset: PortraitPreset } | { seed: string };
  roleDescription: string;
  instructions?: string;
  persona?: Persona;
  bible?: string;
  roleTemplate?: { id: string; version: number };
  model?: { modelRef: string } | { platformModelRef: string };
  skills: string[];
  apps: { app: string; actions: string[] }[];
  routines: RoutineDraft[];
  visibility: "private" | "public";
  staffingTools: boolean;
};

export type EmployeeChangeDraft = {
  agentId: string;
  set: Partial<Omit<EmployeeDraft, "roleTemplate" | "staffingTools">>;
  appsRemove: { app: string; actions: string[] }[];
  routinesRemove: string[];
};

/** 至少 2、至多 20、不重复。 */
export type GroupDraft = { name: string; members: string[] };

export type GroupChangeDraft = {
  channelId: string;
  name?: string;
  add: string[];
  remove: string[];
  order?: string[];
};

export type ProposalDraft =
  | EmployeeDraft
  | EmployeeChangeDraft
  | GroupDraft
  | GroupChangeDraft;

export type ResultItem = {
  step: string;
  target?: string;
  outcome: "done" | "requested" | "needs_connection" | "failed";
  message?: string;
};

export type Proposal = {
  id: string;
  ownerId: string;
  proposedByAgentId: string;
  threadId: string | null;
  kind: ProposalKind;
  draft: ProposalDraft;
  baseVersion: string | null;
  status: ProposalStatus;
  result: ResultItem[] | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};
